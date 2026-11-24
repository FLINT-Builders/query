/**
 * Spec for the compression middleware on the React Native example's Expo dev
 * server (`expo start` -> @expo/cli).
 *
 * compression before 1.8.2 never destroys the zlib stream when a client
 * disconnects while a compressed body is still going out. These tests fail
 * on the locked 1.8.1 package and pass once `@expo/cli` resolves compression
 * 1.8.2 or later.
 *
 * Run:
 *   node --test examples/react/react-native/compression-abort-leak.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
)

const createdStreams = []
for (const name of ['createGzip', 'createDeflate', 'createBrotliCompress']) {
  const original = zlib[name]
  Object.defineProperty(zlib, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function wrappedCreate (...args) {
      const stream = original.apply(this, args)
      createdStreams.push(stream)
      return stream
    },
  })
}

// Same bytes Metro hands to res.end / a piped source file: large enough that
// the compressed output exceeds the socket highWaterMark and the zlib stream
// stays paused after the client aborts.
const body = Buffer.alloc(2 * 1024 * 1024)
for (let offset = 0; offset < body.length; offset += 4) {
  body.writeUInt32LE((offset * 2654435761) >>> 0, offset)
}

let server
let port
let sourceFile

function compressionVersionFromLockfile () {
  const lockfile = fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const lines = lockfile.split('\n')
  let inExpoCli = false
  let inDependencies = false
  for (const line of lines) {
    if (/^ {2}'@expo\/cli@/.test(line)) {
      inExpoCli = true
      inDependencies = false
      continue
    }
    if (inExpoCli && /^ {2}\S/.test(line)) {
      inExpoCli = false
      inDependencies = false
    }
    if (!inExpoCli) continue
    if (line === '    dependencies:') {
      inDependencies = true
      continue
    }
    if (inDependencies && /^ {4}\S/.test(line)) {
      inDependencies = false
    }
    if (!inDependencies) continue
    const match = line.match(/^ {6}compression: (\S+)\s*$/)
    if (match) return match[1]
  }
  throw new Error('pnpm-lock.yaml does not pin compression for @expo/cli')
}

function installLockedCompression (version) {
  const directory = path.join(os.tmpdir(), `query-compression-abort-${version}`)
  const compressionPackage = path.join(
    directory,
    'node_modules',
    'compression',
    'package.json',
  )
  if (!fs.existsSync(compressionPackage)) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ private: true }),
    )
    execFileSync(
      'npm',
      [
        'install',
        '--silent',
        '--prefix',
        directory,
        `compression@${version}`,
        'connect@3.7.0',
      ],
      { stdio: 'inherit' },
    )
  }
  const requireFromInstall = createRequire(path.join(directory, 'package.json'))
  const installed = requireFromInstall('compression/package.json').version
  assert.equal(
    installed,
    version,
    `installed compression ${installed}, lockfile asks for ${version}`,
  )
  return {
    compression: requireFromInstall('compression'),
    connect: requireFromInstall('connect'),
  }
}

// createMetroMiddleware sets these before compression() so a later response
// is still eligible to be compressed (no "no-transform").
function noCacheMiddleware (req, res, next) {
  res.setHeader('Surrogate-Control', 'no-store')
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  next()
}

function bundleResponse (req, res) {
  // Metro Server._processBundleRequest finish(): one JavaScript body.
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8')
  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}

function sourceResponse (req, res) {
  // Metro Server._processSourceRequest: stream the file through res.
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/javascript')
  fs.createReadStream(sourceFile).pipe(res)
}

function abortCompressedRequest (encoding, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        headers: {
          'Accept-Encoding': encoding,
          Host: `127.0.0.1:${port}`,
        },
      },
      (response) => {
        const contentEncoding = response.headers['content-encoding'] || ''
        response.on('data', () => request.destroy())
        response.on('error', () => {})
        response.on('close', () => resolve(contentEncoding))
      },
    )
    request.on('error', (error) => {
      if (error.code === 'ECONNRESET') return
      reject(error)
    })
    request.end()
  })
}

async function waitForStreams (streams) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (streams.every((stream) => stream.destroyed)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

before(async () => {
  const version = compressionVersionFromLockfile()
  const { compression, connect } = installLockedCompression(version)
  sourceFile = path.join(os.tmpdir(), `query-compression-source-${process.pid}.js`)
  fs.writeFileSync(sourceFile, body)

  const app = connect()
  app.use(noCacheMiddleware)
  app.use(compression())
  app.use('/[metro-project]/', sourceResponse)
  app.use(bundleResponse)

  server = http.createServer(app)
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

after(() => {
  server?.close()
  if (sourceFile && fs.existsSync(sourceFile)) fs.unlinkSync(sourceFile)
})

for (const encoding of ['gzip', 'deflate', 'br']) {
  test(`aborted bundle response releases the ${encoding} stream`, async () => {
    const started = createdStreams.length
    const rounds = 3
    const encodings = []
    for (let i = 0; i < rounds; i++) {
      encodings.push(
        await abortCompressedRequest(encoding, '/index.bundle?platform=ios&dev=true'),
      )
    }
    const streams = createdStreams.slice(started)
    await waitForStreams(streams)

    assert.equal(streams.length, rounds)
    assert.deepEqual(encodings, Array(rounds).fill(encoding))
    for (const stream of streams) {
      assert.equal(
        stream.destroyed,
        true,
        `${encoding} zlib stream still has a live handle after the client aborted`,
      )
    }
  })

  test(`aborted source-file response releases the ${encoding} stream`, async () => {
    const started = createdStreams.length
    const contentEncoding = await abortCompressedRequest(
      encoding,
      '/[metro-project]/node_modules/react-native/Libraries/Blob/Blob.js',
    )
    const streams = createdStreams.slice(started)
    await waitForStreams(streams)

    assert.equal(streams.length, 1)
    assert.equal(contentEncoding, encoding)
    assert.equal(
      streams[0].destroyed,
      true,
      `${encoding} zlib stream still has a live handle after the client aborted`,
    )
  })
}
