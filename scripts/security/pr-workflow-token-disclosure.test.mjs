/**
 * Spec for the pull-request workflow access-token disclosure.
 *
 * These tests fail while `.github/workflows/pr.yml` gives NX_CLOUD_ACCESS_TOKEN
 * to unpinned registry commands or to scripts taken from the pull request.
 * They pass once that disclosure is closed.
 *
 * Run:
 *   node --test scripts/security/pr-workflow-token-disclosure.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = path.join(repoRoot, '.github/workflows/pr.yml')

function toolBin() {
  const candidates = [
    '/home/ubuntu/.nvm/versions/node/v22.23.4/bin',
    path.dirname(process.execPath),
  ]
  for (const dir of candidates) {
    const npm = path.join(dir, 'npm')
    if (!existsSync(npm)) continue
    const version = spawnSync(npm, ['-v'], { encoding: 'utf8' })
    if (version.stdout.trim() === '10.9.9') return dir
  }
  return candidates.find((dir) => existsSync(path.join(dir, 'npx'))) ?? ''
}

const toolBinDir = toolBin()

// Obvious placeholder. This is not a credential.
const PLACEHOLDER = 'placeholder-nx-cloud-access-token'

const ATTACKER_LATEST = '9.9.9'
const PUBLISHED_AT = '2020-01-15T00:00:00.000Z'

const EXFIL_SOURCE = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const sink = process.env.TOKEN_SINK
if (sink) writeFileSync(sink, process.env.NX_CLOUD_ACCESS_TOKEN ?? '')
`

const BENIGN_SOURCE = `#!/usr/bin/env node
process.exit(0)
`

const SCRIPT_EXFIL = `import { writeFileSync } from 'node:fs'
const sink = process.env.TOKEN_SINK
if (sink) writeFileSync(sink, process.env.NX_CLOUD_ACCESS_TOKEN ?? '')
`

function parseWorkflow(text) {
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import json,sys,yaml; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)',
    ],
    { input: text, encoding: 'utf8' },
  )
  if (parsed.status !== 0) {
    throw new Error(parsed.stderr || 'failed to parse workflow YAML')
  }
  return JSON.parse(parsed.stdout)
}

function evaluateExpressions(value, secrets) {
  return String(value ?? '').replace(
    /\$\{\{\s*secrets(?:\.([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])\s*\}\}/g,
    (_match, dotted, bracketed) => {
      const name = dotted || bracketed
      return Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : ''
    },
  )
}

function evaluateEnvMap(mapping, secrets) {
  const out = {}
  for (const [key, value] of Object.entries(mapping ?? {})) {
    out[key] = evaluateExpressions(value, secrets)
  }
  return out
}

/**
 * Same-repository pull_request jobs receive repository secrets.
 * Fork pull_request jobs do not. This spec exercises the same-repository case,
 * which is the case the workflow runs for maintainer branches.
 */
function sameRepositorySecrets() {
  return { NX_CLOUD_ACCESS_TOKEN: PLACEHOLDER }
}

function stepEnvironment(workflow, job, step) {
  const secrets = sameRepositorySecrets()
  return {
    ...evaluateEnvMap(workflow.env, secrets),
    ...evaluateEnvMap(job.env, secrets),
    ...evaluateEnvMap(step.env, secrets),
  }
}

function isExactVersion(spec) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec)
}

function packageInvocation(command) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const invocations = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const tool = token.split('/').pop()
    if (!['npx', 'pnpx', 'npm', 'pnpm'].includes(tool)) continue
    let cursor = i + 1
    if (tool === 'npm' || tool === 'pnpm') {
      if (tokens[cursor] !== 'exec' && tokens[cursor] !== 'dlx') continue
      cursor++
    }
    let packageSpec = null
    while (cursor < tokens.length) {
      const arg = tokens[cursor]
      if (arg === '--') {
        cursor++
        continue
      }
      if (arg.startsWith('--package=')) {
        packageSpec = arg.slice('--package='.length)
        break
      }
      if (arg === '--package' || arg === '-p') {
        packageSpec = tokens[cursor + 1] ?? null
        break
      }
      if (arg.startsWith('-')) {
        cursor++
        continue
      }
      packageSpec = arg
      break
    }
    if (!packageSpec) continue
    const at = packageSpec.lastIndexOf('@')
    const name = at > 0 ? packageSpec.slice(0, at) : packageSpec
    const version = at > 0 ? packageSpec.slice(at + 1) : null
    invocations.push({ name, version, exact: version != null && isExactVersion(version) })
  }
  return invocations
}

function runsRepositoryScript(command) {
  return /(?:^|[;&|]\s*)(?:pnpm|npm|yarn|bun)\s+run\s+\S+/.test(command)
}

function sizeLimitBuildCommand(step) {
  const uses = String(step.uses ?? '')
  if (!uses.includes('size-limit-action')) return null
  const skip = step.with?.skip_step
  if (skip === 'build') return null
  const script = step.with?.build_script || 'build'
  const manager = step.with?.package_manager
  if (manager) return `${manager} run ${script}`
  const lockfile = path.join(repoRoot, 'pnpm-lock.yaml')
  if (existsSync(lockfile)) return `pnpm run ${script}`
  return `npm run ${script}`
}

function collectCases(workflow) {
  const cases = []
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const env = stepEnvironment(workflow, job, step)
      if (typeof step.run === 'string') {
        const command = step.run
        const packages = packageInvocation(command)
        const interesting =
          packages.some((pkg) => pkg.name === 'nx-cloud' || pkg.name === 'pkg-pr-new') ||
          runsRepositoryScript(command)
        if (interesting) {
          cases.push({
            title: `${jobName} / ${step.name ?? command}`,
            command,
            env,
            packages,
          })
        }
      }
      const buildCommand = sizeLimitBuildCommand(step)
      if (buildCommand) {
        cases.push({
          title: `${jobName} / ${step.name ?? 'size-limit'} build script`,
          command: buildCommand,
          env,
          packages: [],
        })
      }
    }
  }
  return cases
}

function packTarball(dir) {
  const destination = path.join(dir, '..')
  const packed = spawnSync('npm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: dir,
    encoding: 'utf8',
  })
  if (packed.status !== 0) {
    throw new Error(packed.stderr || 'npm pack failed')
  }
  const info = JSON.parse(packed.stdout)
  const filename = info[0].filename
  const tarballPath = path.join(destination, filename)
  const bytes = readFileSync(tarballPath)
  return {
    bytes,
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}

function writePackage(root, name, version, binName, source) {
  const dir = path.join(root, `${name}-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        version,
        bin: { [binName]: 'bin.js' },
      },
      null,
      2,
    ),
  )
  writeFileSync(path.join(dir, 'bin.js'), source, { mode: 0o755 })
  return packTarball(dir)
}

function manifest(name, version, tarballUrl, packed) {
  return {
    name,
    version,
    bin: { [name]: 'bin.js' },
    dist: {
      tarball: tarballUrl,
      shasum: packed.shasum,
      integrity: packed.integrity,
    },
  }
}

function createRegistry(state) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'
    const parts = pathname.split('/').filter(Boolean)
    if (request.method === 'GET' && parts.length === 3 && parts[1] === '-') {
      const name = parts[0]
      const file = parts[2]
      const prefix = `${name}-`
      const version = file.startsWith(prefix) && file.endsWith('.tgz')
        ? file.slice(prefix.length, -'.tgz'.length)
        : null
      const packed = version ? state.packages[name]?.tarballs[version] : null
      if (!packed) {
        response.writeHead(404)
        response.end(`missing tarball ${pathname}`)
        return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(packed.bytes)
      return
    }
    if (request.method === 'GET' && parts.length === 1) {
      const entry = state.packages[parts[0]]
      if (!entry) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: `not found ${pathname}` }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(entry.packument))
      return
    }
    response.writeHead(404)
    response.end(`not found ${pathname}`)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        registry: `http://127.0.0.1:${address.port}/`,
      })
    })
  })
}

function buildRegistryPackages(cases, registry) {
  const stage = path.join(tmpdir(), `nx-token-packages-${process.pid}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const wanted = new Map()
  const remember = (name, version, exfiltrate) => {
    const key = `${name}@${version}`
    const previous = wanted.get(key)
    wanted.set(key, { name, version, exfiltrate: previous?.exfiltrate || exfiltrate })
  }
  remember('nx-cloud', ATTACKER_LATEST, true)
  remember('pkg-pr-new', ATTACKER_LATEST, true)
  for (const stepCase of cases) {
    for (const pkg of stepCase.packages) {
      if (pkg.name !== 'nx-cloud' && pkg.name !== 'pkg-pr-new') continue
      if (pkg.exact) {
        const exfiltrate = pkg.name === 'pkg-pr-new' || pkg.version === ATTACKER_LATEST
        remember(pkg.name, pkg.version, exfiltrate)
      }
    }
  }
  const built = {}
  for (const item of wanted.values()) {
    const source = item.exfiltrate ? EXFIL_SOURCE : BENIGN_SOURCE
    const packed = writePackage(stage, item.name, item.version, item.name, source)
    built[item.name] ??= { versions: {}, tarballs: {} }
    built[item.name].tarballs[item.version] = packed
    const tarballUrl = `${registry}${item.name}/-/${item.name}-${item.version}.tgz`
    built[item.name].versions[item.version] = manifest(item.name, item.version, tarballUrl, packed)
  }
  for (const entry of Object.values(built)) {
    const versions = entry.versions
    entry.packument = {
      name: Object.values(versions)[0].name,
      'dist-tags': { latest: ATTACKER_LATEST },
      modified: PUBLISHED_AT,
      time: {
        created: PUBLISHED_AT,
        modified: PUBLISHED_AT,
        ...Object.fromEntries(Object.keys(versions).map((version) => [version, PUBLISHED_AT])),
      },
      versions,
    }
  }
  return built
}

function runnerEnvironment(stepEnv, workspace, sink, registry) {
  const env = { ...process.env, ...stepEnv }
  env.GITHUB_ACTIONS = 'true'
  if (!env.CI) env.CI = 'true'
  env.TOKEN_SINK = sink
  env.npm_config_registry = registry
  env.npm_config_update_notifier = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_cache = path.join(workspace, '.npm-cache')
  env.npm_config_store_dir = path.join(workspace, '.pnpm-store')
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  env.PATH = `${toolBinDir}${path.delimiter}${env.PATH ?? ''}`
  delete env.NODE_OPTIONS
  return env
}

function executeStep(command, env, workspace) {
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'pull-request-merge',
        private: true,
        packageManager: 'pnpm@11.9.0',
        scripts: {
          'test:pr': 'node ./read-token.mjs',
          'build:all': 'node ./read-token.mjs',
          build: 'node ./read-token.mjs',
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(path.join(workspace, 'read-token.mjs'), SCRIPT_EXFIL)
  writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
  const workspaceConfig = path.join(repoRoot, 'pnpm-workspace.yaml')
  if (existsSync(workspaceConfig)) {
    writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), readFileSync(workspaceConfig))
  }
  const npmrc = path.join(repoRoot, '.npmrc')
  const npmrcText = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : ''
  // pnpm 11.9.0 reads the registry from .npmrc (loadNpmrcConfig), not from
  // npm_config_registry. Point that copy at the stand-in registry.
  writeFileSync(
    path.join(workspace, '.npmrc'),
    `${npmrcText.trim()}\nregistry=${env.npm_config_registry}\n`,
  )
  const scriptPath = path.join(workspace, 'step.sh')
  writeFileSync(scriptPath, command)
  // The registry server shares this process. spawnSync would block it and deadlock
  // the package download the step is waiting on.
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-e', scriptPath], {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 120_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

const workflow = parseWorkflow(readFileSync(workflowPath, 'utf8'))
const cases = collectCases(workflow)
const registryState = { packages: {} }
let registryUrl = ''
let registryServer

test.before(async () => {
  const started = await createRegistry(registryState)
  registryServer = started.server
  registryUrl = started.registry
  registryState.packages = buildRegistryPackages(cases, registryUrl)
})

test.after(() => {
  registryServer?.close()
})

for (const stepCase of cases) {
  test(stepCase.title, { timeout: 180_000 }, async () => {
    const workspace = path.join(
      tmpdir(),
      `nx-token-step-${process.pid}-${Math.random().toString(16).slice(2)}`,
    )
    const sink = path.join(workspace, 'sink.txt')
    const env = runnerEnvironment(stepCase.env, workspace, sink, registryUrl)
    const result = await executeStep(stepCase.command, env, workspace)
    const captured = existsSync(sink) ? readFileSync(sink, 'utf8') : ''
    assert.equal(
      result.status,
      0,
      `step failed before completing\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    assert.ok(
      !captured.includes(PLACEHOLDER),
      `${stepCase.title} could read NX_CLOUD_ACCESS_TOKEN from the environment`,
    )
    rmSync(workspace, { recursive: true, force: true })
  })
}
