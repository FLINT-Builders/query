/**
 * Spec for GHSA-wfc6-r584-vfw7 / CVE-2026-44576 as it reaches the App Router
 * apps in this repo.
 *
 * Next classifies only the literal header value "1" as an RSC request when it
 * decides whether a response may be served for the original URL, but the App
 * Router renderer treats any present or repeated `rsc` header as a flight
 * request. A static (or otherwise shared-cacheable) route then answers the
 * original URL with `text/x-component` and a cache policy a shared cache will
 * store. A cache that keys only on the URL, and does not partition on Vary,
 * keeps that flight body and serves it to a later visitor who asked for HTML.
 *
 * These tests fail while the locked next versions do that, and pass once next
 * is upgraded to 15.5.16 / 16.2.5 or later, which only treat the literal
 * string "1" as an RSC request.
 *
 * The cache below follows the URL-only cache in Next.js
 * test/e2e/app-dir/segment-cache/cdn-cache-busting/server.mjs (v16.2.2):
 * GET responses are stored unless Cache-Control contains no-store, and the
 * key is the request URL alone.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const apps = [
  {
    name: 'examples/react/nextjs-app-prefetching',
    dir: 'examples/react/nextjs-app-prefetching',
    routes: ['/', '/_not-found'],
  },
  {
    name: 'examples/react/nextjs-app-optimistic-updates',
    dir: 'examples/react/nextjs-app-optimistic-updates',
    routes: ['/', '/_not-found'],
  },
  {
    name: 'examples/react/nextjs-suspense-streaming',
    dir: 'examples/react/nextjs-suspense-streaming',
    routes: ['/', '/_not-found'],
  },
  {
    name: 'integrations/react-next-16',
    dir: 'integrations/react-next-16',
    routes: ['/', '/_not-found'],
  },
  {
    name: 'integrations/react-next-15',
    dir: 'integrations/react-next-15',
    routes: ['/', '/_not-found'],
  },
  {
    name: 'integrations/react-next-14',
    dir: 'integrations/react-next-14',
    routes: ['/', '/_not-found'],
  },
]

const attacks = [
  {
    name: 'rsc header 0',
    headers: ['rsc: 0'],
  },
  {
    name: 'repeated rsc header',
    headers: ['rsc: 1', 'rsc: 1'],
  },
]

const childEnv = {
  ...process.env,
  CI: '1',
  NEXT_TELEMETRY_DISABLED: '1',
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`))
    })
  })
}

function listenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function rawGet(port, urlPath, headerLines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timeout waiting for ${urlPath}`))
    }, 20000)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => {
      clearTimeout(timer)
      try {
        resolve(parseHttpResponse(Buffer.concat(chunks)))
      } catch (error) {
        reject(error)
      }
    })
    const request = [
      `GET ${urlPath} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Accept: text/html',
      'Connection: close',
      ...headerLines,
      '',
      '',
    ].join('\r\n')
    socket.write(request)
  })
}

function parseHttpResponse(buffer) {
  const separator = buffer.indexOf('\r\n\r\n')
  if (separator < 0) throw new Error('HTTP response had no header terminator')
  const head = buffer.subarray(0, separator).toString('latin1')
  let body = buffer.subarray(separator + 4)
  const lines = head.split('\r\n')
  const status = Number(lines[0].split(' ')[1])
  const headers = new Map()
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':')
    if (index < 0) continue
    const name = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    const previous = headers.get(name)
    headers.set(name, previous ? `${previous}, ${value}` : value)
  }
  if (headers.get('transfer-encoding')?.includes('chunked')) {
    body = decodeChunked(body)
  }
  return { status, headers, body }
}

function decodeChunked(buffer) {
  const parts = []
  let offset = 0
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset)
    if (lineEnd < 0) break
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1'), 16)
    if (!Number.isFinite(size)) break
    if (size === 0) break
    const start = lineEnd + 2
    parts.push(buffer.subarray(start, start + size))
    offset = start + size + 2
  }
  return Buffer.concat(parts)
}

function isSharedCacheable(headers) {
  const cacheControl = headers.get('cache-control') ?? ''
  return !cacheControl.toLowerCase().includes('no-store')
}

/**
 * Shared cache that does not partition response variants. The key is the
 * URL. Vary is ignored. Responses marked no-store are not stored.
 */
function createUrlOnlyCache(originPort) {
  const entries = new Map()
  return async function throughCache(urlPath, headerLines) {
    const cached = entries.get(urlPath)
    if (cached) return { source: 'hit', ...cached }
    const response = await rawGet(originPort, urlPath, headerLines)
    if (isSharedCacheable(response.headers)) {
      entries.set(urlPath, response)
      return { source: 'stored', ...response }
    }
    return { source: 'bypass', ...response }
  }
}

async function startNext(appDir) {
  const port = await listenPort()
  const child = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: appDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const deadline = Date.now() + 30000
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`next start exited ${child.exitCode}\n${output}`)
    }
    try {
      const response = await rawGet(port, '/', [])
      if (response.status) {
        ready = true
        break
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (!ready) {
    child.kill('SIGTERM')
    throw new Error(`next start did not listen\n${output}`)
  }
  return {
    port,
    async stop() {
      if (child.exitCode != null) return
      child.kill('SIGTERM')
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      if (child.exitCode == null) child.kill('SIGKILL')
    },
  }
}

function assertDocument(response, label) {
  const contentType = response.headers.get('content-type') ?? ''
  const text = response.body.toString('utf8')
  assert.ok(
    contentType.includes('text/html'),
    `${label} content-type should be HTML, got ${contentType || '(none)'} ` +
      `(cache ${response.source}, status ${response.status}, body ${text.slice(0, 80)})`,
  )
  assert.ok(
    text.includes('<!DOCTYPE html') || text.includes('<html'),
    `${label} body should be the HTML document, got ${text.slice(0, 80)}`,
  )
  assert.equal(
    contentType.includes('text/x-component'),
    false,
    `${label} served a React Server Component payload for the document URL`,
  )
}

test.before(async () => {
  await run(
    'pnpm',
    [
      '--filter',
      '@tanstack/query-core',
      '--filter',
      '@tanstack/query-devtools',
      '--filter',
      '@tanstack/react-query',
      '--filter',
      '@tanstack/react-query-devtools',
      '--filter',
      '@tanstack/react-query-next-experimental',
      'build',
    ],
    repoRoot,
  )
})

for (const app of apps) {
  test(`${app.name} does not let a non-canonical RSC request poison a URL-only cache`, async () => {
    const appDir = path.join(repoRoot, app.dir)
    await run('pnpm', ['run', 'build'], appDir)
    const server = await startNext(appDir)
    try {
      for (const route of app.routes) {
        for (const attack of attacks) {
          const cache = createUrlOnlyCache(server.port)
          const urlPath = `${route}${route.includes('?') ? '&' : '?'}probe=${encodeURIComponent(attack.name)}`
          await cache(urlPath, attack.headers)
          const laterVisitor = await cache(urlPath, [])
          assertDocument(
            laterVisitor,
            `${app.name} ${route} after ${attack.name}`,
          )
        }
      }
    } finally {
      await server.stop()
    }
  })
}
