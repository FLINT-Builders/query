'use strict'

/**
 * Spec for the undici TLS 1.2 renegotiation crash reached by this repo.
 *
 * These tests fail while @expo/cli resolves the locked vulnerable undici.
 * They pass once that locked undici no longer aborts the process when a
 * TLS 1.2 peer renegotiates onto a CA-trusted certificate for another host.
 *
 * Run from the repository root:
 *   node --test scripts/undici-tls-renegotiation.test.cjs
 */

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { constants } = require('node:crypto')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const tls = require('node:tls')

const repoRoot = path.resolve(__dirname, '..')

if (process.env.UNDICI_TLS_CHILD) {
  runChild(process.env.UNDICI_TLS_CHILD).catch((error) => {
    console.error('CHILD_FAILED', error && error.stack ? error.stack : error)
    process.exit(2)
  })
} else {
  let installDir
  let certs

  test.before(() => {
    const locked = readLockedExpoUndici(fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'))
    installDir = installLockedClient(locked)
    certs = makeCertificates()
  })

  test('telemetry fetch survives a completed TLS 1.2 request', () => {
    const result = runMode('telemetry-ok', { installDir, certs })
    assert.equal(result.status, 0, combined(result))
    assert.match(combined(result), /CONTROL_OK/)
  })

  test('expo start telemetry survives a TLS 1.2 renegotiation onto a different host certificate', () => {
    assertSurvived(runMode('telemetry', { installDir, certs }))
  })

  test('Expo Go download survives a TLS 1.2 renegotiation onto a different host certificate', () => {
    assertSurvived(runMode('download', { installDir, certs }))
  })

  test('proxied Expo API fetch survives a TLS 1.2 renegotiation onto a different host certificate', () => {
    assertSurvived(runMode('proxy', { installDir, certs }))
  })
}

function assertSurvived (result) {
  const output = combined(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /RENEGOTIATED/)
  assert.doesNotMatch(output, /AssertionError/)
  assert.doesNotMatch(output, /ERR_ASSERTION/)
}

function combined (result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function runMode (mode, { installDir, certs }) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NODE_TEST') || key.startsWith('NODE_CHANNEL')) continue
    env[key] = value
  }
  delete env.HTTP_PROXY
  delete env.http_proxy
  delete env.HTTPS_PROXY
  delete env.https_proxy
  delete env.NO_PROXY
  delete env.no_proxy
  env.UNDICI_TLS_CHILD = mode
  env.UNDICI_TLS_INSTALL = installDir
  env.NODE_EXTRA_CA_CERTS = certs.ca
  env.MATCHING_KEY = certs.matchingKey
  env.MATCHING_CERT = certs.matchingCert
  env.WRONG_KEY = certs.wrongKey
  env.WRONG_CERT = certs.wrongCert
  return spawnSync(process.execPath, [__filename], {
    env,
    encoding: 'utf8',
    timeout: 20000,
  })
}

function readLockedExpoUndici (lockText) {
  const lines = lockText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^ {2}'@expo\/cli@([^'(]+)(?:\([^)]*\))?':\s*$/)
    if (!header) continue
    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {2}\S/.test(lines[j])) break
      const dep = lines[j].match(/^ {6}undici: (\d+\.\d+\.\d+)\s*$/)
      if (dep) return { expoVersion: header[1], undiciVersion: dep[1] }
    }
  }
  throw new Error('pnpm-lock.yaml does not pin undici for @expo/cli')
}

function installLockedClient ({ expoVersion, undiciVersion }) {
  const installDir = path.join(os.tmpdir(), 'query-undici-tls-test', `${expoVersion}-${undiciVersion}`)
  const pkgPath = path.join(installDir, 'package.json')
  const wanted = {
    name: 'query-undici-tls-test',
    private: true,
    dependencies: {
      '@expo/cli': expoVersion,
      undici: undiciVersion,
    },
    overrides: {
      undici: undiciVersion,
    },
  }
  const undiciPkg = path.join(installDir, 'node_modules', 'undici', 'package.json')
  const already = fs.existsSync(undiciPkg) &&
    JSON.parse(fs.readFileSync(undiciPkg, 'utf8')).version === undiciVersion &&
    fs.existsSync(pkgPath) &&
    JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies['@expo/cli'] === expoVersion
  if (!already) {
    fs.mkdirSync(installDir, { recursive: true })
    fs.writeFileSync(pkgPath, JSON.stringify(wanted))
    const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: installDir,
      encoding: 'utf8',
      timeout: 180000,
    })
    if (installed.status !== 0) {
      throw new Error(`npm install failed\n${installed.stdout}\n${installed.stderr}`)
    }
  }
  const resolved = JSON.parse(fs.readFileSync(undiciPkg, 'utf8')).version
  if (resolved !== undiciVersion) {
    throw new Error(`installed undici ${resolved}, lockfile pins ${undiciVersion}`)
  }
  return installDir
}

function makeCertificates () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undici-tls-certs-'))
  const caKey = path.join(dir, 'ca.key')
  const ca = path.join(dir, 'ca.pem')
  const matchingKey = path.join(dir, 'localhost.key')
  const matchingCsr = path.join(dir, 'localhost.csr')
  const matchingCert = path.join(dir, 'localhost.crt')
  const wrongKey = path.join(dir, 'wrong.key')
  const wrongCsr = path.join(dir, 'wrong.csr')
  const wrongCert = path.join(dir, 'wrong.crt')
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '1', '-subj', '/CN=TestCA'])
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', matchingKey, '-out', matchingCsr, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'])
  openssl(['x509', '-req', '-in', matchingCsr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', matchingCert, '-days', '1', '-copy_extensions', 'copy'])
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', wrongKey, '-out', wrongCsr, '-subj', '/CN=wrong.example', '-addext', 'subjectAltName=DNS:wrong.example'])
  openssl(['x509', '-req', '-in', wrongCsr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', wrongCert, '-days', '1', '-copy_extensions', 'copy'])
  return { ca, matchingKey, matchingCert, wrongKey, wrongCert }
}

function openssl (args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`openssl ${args.join(' ')} failed\n${result.stderr}`)
  }
}

async function runChild (mode) {
  const { createRequire } = require('node:module')
  const requireFromInstall = createRequire(path.join(process.env.UNDICI_TLS_INSTALL, 'package.json'))
  const renegotiate = mode !== 'telemetry-ok'
  const server = await startTlsServer({ renegotiate })
  try {
    if (mode === 'telemetry' || mode === 'telemetry-ok') {
      const { FetchClient } = requireFromInstall('@expo/cli/build/src/utils/telemetry/clients/FetchClient.js')
      const client = new FetchClient({ url: `https://localhost:${server.port}/v1/batch` })
      await client.record({ type: 'track', event: 'start' })
      await client.flush()
    } else if (mode === 'download') {
      const { downloadAppAsync } = requireFromInstall('@expo/cli/build/src/utils/downloadAppAsync.js')
      const outputPath = path.join(os.tmpdir(), `expo-go-${process.pid}.bin`)
      try {
        await downloadAppAsync({
          url: `https://localhost:${server.port}/ExpoGo.bin`,
          outputPath,
          extract: false,
        })
      } catch (error) {
        console.error('DOWNLOAD_CAUGHT', error && error.name, error && error.message)
      } finally {
        fs.rmSync(outputPath, { force: true })
      }
    } else if (mode === 'proxy') {
      const proxy = await startConnectProxy()
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
      process.env.http_proxy = process.env.HTTP_PROXY
      const { fetchAsync } = requireFromInstall('@expo/cli/build/src/api/rest/client.js')
      try {
        await fetchAsync(`https://localhost:${server.port}/versions/latest`)
      } catch (error) {
        const cause = error && error.cause
        console.error('PROXY_CAUGHT', error && error.name, cause && cause.code, error && error.message)
      } finally {
        proxy.close()
      }
    } else {
      throw new Error(`unknown child mode ${mode}`)
    }
  } finally {
    server.close()
  }
  if (renegotiate && !server.renegotiated) {
    console.error('RENEGOTIATION_DID_NOT_START')
    process.exit(3)
  }
  console.error(renegotiate ? 'RENEGOTIATED' : 'CONTROL_OK')
  process.exit(0)
}

function startTlsServer ({ renegotiate }) {
  const matching = {
    key: fs.readFileSync(process.env.MATCHING_KEY),
    cert: fs.readFileSync(process.env.MATCHING_CERT),
  }
  const wrongHost = {
    key: fs.readFileSync(process.env.WRONG_KEY),
    cert: fs.readFileSync(process.env.WRONG_CERT),
  }
  const state = { renegotiated: false, port: 0, close () {} }
  const server = tls.createServer({
    ...matching,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    secureOptions: constants.SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION,
    ALPNProtocols: ['http/1.1'],
  }, (socket) => {
    socket.on('error', () => {})
    socket.on('data', () => {
      if (!renegotiate) {
        if (!state.started) {
          state.started = true
          socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok')
        }
        return
      }
      if (state.started) return
      state.started = true
      setTimeout(() => {
        socket.setKeyCert(wrongHost)
        state.renegotiated = socket.renegotiate({
          requestCert: false,
          rejectUnauthorized: false,
        }, () => {}) === true
      }, 50)
    })
  })
  server.listen(0, 'localhost')
  return once(server, 'listening').then(() => {
    state.port = server.address().port
    state.close = () => server.close()
    return state
  })
}

function startConnectProxy () {
  const proxy = http.createServer((_request, response) => {
    response.writeHead(405)
    response.end()
  })
  proxy.on('connect', (request, clientSocket, head) => {
    const [host, port] = request.url.split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  proxy.listen(0, '127.0.0.1')
  return once(proxy, 'listening').then(() => ({
    port: proxy.address().port,
    close () {
      proxy.close()
    },
  }))
}
