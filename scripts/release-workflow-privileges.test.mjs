/**
 * Privileged release credentials must not reach scripts from a branch push.
 *
 * These tests execute the release and pull-request workflow path:
 * branch filter, job `if`, permissions, checkout credential persistence,
 * and `pnpm` 11.9.0 running the scripts named by the workflow.
 * They fail while that path still hands the checked-out commit a
 * contents-write token, an OIDC request token, or the Nx Cloud token.
 *
 * `autofix.yml` is included. It uses the same branch filters and runs
 * repository scripts, but it does not grant those credentials.
 * The pinned changeset-preview action in `version-preview` is not executed.
 * That job still runs the setup action's `pnpm install`, which is.
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowsDir = path.join(repoRoot, '.github/workflows')
const pnpmSpec = 'pnpm@11.9.0'
const setupAction =
  'TanStack/config/.github/setup@e4b48f16568324f76f467aa4c2aac2f05db632c3'
const changesetsAction =
  'changesets/action@63a615b9cd06ba9a3e6d13796c7fbcb080a60a0b'

const PLACEHOLDER_TOKEN = 'PLACEHOLDER_GITHUB_TOKEN'
const PLACEHOLDER_NX = 'PLACEHOLDER_NX_CLOUD_ACCESS_TOKEN'
const PLACEHOLDER_OIDC = 'PLACEHOLDER_OIDC_REQUEST_TOKEN'

const WRITE_PERMISSIONS = ['contents', 'pull-requests', 'id-token']

test('GitHub Actions filter patterns match the documented cheat sheet', () => {
  const cases = [
    ['feature/*', 'feature/my-branch', true],
    ['feature/*', 'feature/your-branch', true],
    ['feature/*', 'feature/mona/the/octocat', false],
    ['feature/**', 'feature/beta-a/my-branch', true],
    ['feature/**', 'feature/your-branch', true],
    ['feature/**', 'feature/mona/the/octocat', true],
    ['main', 'main', true],
    ['main', 'main-extra', false],
    ['releases/mona-the-octocat', 'releases/mona-the-octocat', true],
    ['*', 'main', true],
    ['*', 'releases', true],
    ['*', 'all/the/branches', false],
    ['**', 'all/the/branches', true],
    ['**', 'every/tag', true],
    ['*feature', 'mona-feature', true],
    ['*feature', 'feature', true],
    ['*feature', 'ver-10-feature', true],
    ['v2*', 'v2', true],
    ['v2*', 'v2.0', true],
    ['v2*', 'v2.9', true],
    ['v[12].[0-9]+.[0-9]+', 'v1.10.1', true],
    ['v[12].[0-9]+.[0-9]+', 'v2.0.0', true],
    ['v[12].[0-9]+.[0-9]+', 'v3.0.0', false],
    ['*.jsx?', 'page.js', true],
    ['*.jsx?', 'page.jsx', true],
    ['*.jsx?', 'page.j', false],
    ['*-pre', 'attacker-pre', true],
    ['*-pre', 'attacker-preview', false],
    ['*-pre', 'feature/attacker-pre', false],
    ['*-maint', 'attacker-maint', true],
    ['v[0-9]', 'v7', true],
    ['v[0-9]', 'v10', false],
  ]
  for (const [pattern, name, expected] of cases) {
    assert.equal(patternMatches(pattern, name), expected, `${pattern} vs ${name}`)
  }
  assert.equal(
    filterMatches(['releases/**', '!releases/**-alpha'], 'releases/10'),
    true,
  )
  assert.equal(
    filterMatches(['releases/**', '!releases/**-alpha'], 'releases/beta/3-alpha'),
    false,
  )
  assert.equal(
    filterMatches(['main', 'v[0-9]', '*-pre', '*-maint'], 'attacker-pre'),
    true,
  )
})

test('persisted checkout credentials stay readable by a later step', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-cred-'))
  const runnerTemp = path.join(workspace, 'runner')
  fs.mkdirSync(runnerTemp)
  try {
    await exec('git', ['init'], { cwd: workspace })
    persistCheckoutCredentials(workspace, runnerTemp, PLACEHOLDER_TOKEN)
    const script = path.join(workspace, 'read.sh')
    fs.writeFileSync(script, '#!/bin/bash\nnode ./record-exposure.mjs\n')
    fs.writeFileSync(
      path.join(workspace, 'record-exposure.mjs'),
      recorderSource(),
    )
    const report = path.join(workspace, 'report.jsonl')
    await exec(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', script],
      {
        cwd: workspace,
        env: baseEnv(workspace, runnerTemp, report),
      },
    )
    const observed = JSON.parse(fs.readFileSync(report, 'utf8').trim())
    assert.equal(observed.persistedToken, true)
    assert.equal(observed.nx, false)
    assert.equal(observed.oidc, false)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('push of attacker-pre does not give repository scripts release credentials', async () => {
  await assertNoReleaseCredentials(pushEvent('attacker-pre'))
})

test('push of attacker-maint does not give repository scripts release credentials', async () => {
  await assertNoReleaseCredentials(pushEvent('attacker-maint'))
})

test('push of v7 does not give repository scripts release credentials', async () => {
  await assertNoReleaseCredentials(pushEvent('v7'))
})

test('push of v10 does not run the privileged release scripts', async () => {
  const runs = await executeEvent(pushEvent('v10'))
  assert.equal(
    runs.some((run) => run.workflow.endsWith('release.yml')),
    false,
  )
})

test('push of feature/work does not run the privileged release scripts', async () => {
  const runs = await executeEvent(pushEvent('feature/work'))
  assert.equal(
    runs.some((run) => run.workflow.endsWith('release.yml')),
    false,
  )
  assert.deepEqual(privileged(runs), [])
})

test('main does not pass the Nx Cloud token to repository scripts', async () => {
  const runs = await executeEvent(pushEvent('main'))
  const leaked = runs.filter((run) => run.observed.nx)
  assert.deepEqual(
    leaked.map(describeRun),
    [],
    'Nx Cloud token reached a repository script',
  )
})

test('same-repository pull request does not pass the Nx Cloud token to repository scripts', async () => {
  const runs = await executeEvent(pullRequestEvent(false))
  const leaked = runs.filter((run) => run.observed.nx)
  assert.deepEqual(
    leaked.map(describeRun),
    [],
    'Nx Cloud token reached a repository script',
  )
})

test('pull request from a fork does not receive repository secrets', async () => {
  const runs = await executeEvent(pullRequestEvent(true))
  assert.deepEqual(privileged(runs), [])
})

async function assertNoReleaseCredentials(event) {
  const runs = await executeEvent(event)
  assert.deepEqual(
    privileged(runs),
    [],
    'repository scripts observed release credentials',
  )
}

function privileged(runs) {
  return runs.filter(runIsPrivileged).map(describeRun)
}

function runIsPrivileged(run) {
  const tokenVisible =
    run.observed.githubTokenEnv || run.observed.persistedToken
  return (
    run.observed.nx ||
    run.observed.oidc ||
    (tokenVisible && hasWritePermission(run.permissions))
  )
}

function hasWritePermission(permissions) {
  return WRITE_PERMISSIONS.some((name) => permissions[name] === 'write')
}

function describeRun(run) {
  const seen = []
  if (run.observed.persistedToken) seen.push('persisted-github-token')
  if (run.observed.githubTokenEnv) seen.push('github-token-env')
  if (run.observed.oidc) seen.push('oidc-request-token')
  if (run.observed.nx) seen.push('nx-cloud-token')
  const writes = WRITE_PERMISSIONS.filter(
    (name) => run.permissions[name] === 'write',
  )
  return `${run.workflow} ${run.job} ${run.step} (${run.script}) [${writes.join(', ')}] saw ${seen.join(', ')}`
}

function pushEvent(branch) {
  return {
    name: 'push',
    branch,
    ref: `refs/heads/${branch}`,
    refName: branch,
    repositoryOwner: 'TanStack',
    fork: false,
    headCommitMessage: 'attacker change',
  }
}

function pullRequestEvent(fork) {
  return {
    name: 'pull_request',
    branch: 'attacker-pre',
    ref: 'refs/pull/1/merge',
    refName: '1/merge',
    repositoryOwner: 'TanStack',
    fork,
    headCommitMessage: 'attacker change',
  }
}

async function executeEvent(event) {
  const planned = plan(event)
  const runs = []
  for (const step of planned) {
    const observed = await runRepositoryStep(step)
    runs.push({ ...step, observed })
  }
  return runs
}

function plan(event) {
  const planned = []
  for (const file of fs.readdirSync(workflowsDir).filter((name) =>
    name.endsWith('.yml'),
  )) {
    const workflow = loadWorkflow(path.join(workflowsDir, file))
    if (!eventMatches(workflow, event)) continue
    const workflowPermissions = normalizePermissions(workflow.permissions)
    const workflowEnv = resolveEnv(workflow.env, event)
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      if (evaluateIf(job.if, event) === false) continue
      const permissions =
        job.permissions == null
          ? workflowPermissions
          : normalizePermissions(job.permissions)
      const jobEnv = { ...workflowEnv, ...resolveEnv(job.env, event) }
      let credentialsPersisted = false
      for (const step of expandSteps(job.steps ?? [])) {
        if (evaluateIf(step.if, event) === false) continue
        const stepEnv = { ...jobEnv, ...resolveEnv(step.env, event) }
        if (isCheckout(step)) {
          credentialsPersisted = persistCredentials(step)
        }
        for (const command of repositoryCommands(step)) {
          planned.push({
            workflow: `.github/workflows/${file}`,
            job: jobId,
            step: step.name || command.command,
            command: command.command,
            kind: command.kind,
            script: command.script,
            env: stepEnv,
            permissions,
            credentialsPersisted,
            oidc: permissions['id-token'] === 'write',
          })
        }
      }
    }
  }
  return planned
}

function expandSteps(steps) {
  const expanded = []
  for (const step of steps) {
    if (step.uses === setupAction) {
      expanded.push({
        name: 'Get pnpm store directory',
        run: 'echo "STORE_PATH=$(pnpm store path --silent)" >> "$GITHUB_ENV"',
      })
      expanded.push({
        name: 'Install dependencies',
        run: 'pnpm install --frozen-lockfile',
      })
      continue
    }
    expanded.push(step)
  }
  return expanded
}

function isCheckout(step) {
  return typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')
}

function persistCredentials(step) {
  const value = step.with?.['persist-credentials']
  if (value == null) return true
  return String(value).toLowerCase() === 'true'
}

function repositoryCommands(step) {
  const commands = []
  const chunks = []
  if (step.run) chunks.push(String(step.run))
  if (
    typeof step.uses === 'string' &&
    step.uses.startsWith('changesets/action@')
  ) {
    if (step.uses !== changesetsAction) {
      throw new Error(`unexpected changesets action pin: ${step.uses}`)
    }
    for (const key of ['version', 'publish']) {
      if (step.with?.[key]) chunks.push(String(step.with[key]))
    }
  }
  for (const chunk of chunks) {
    const executable = chunk.replace(/\$\{\{[\s\S]*?\}\}/g, ' ').trim()
    const run = executable.match(/(?:^|\n)\s*(?:pnpm|npm)\s+run\s+(\S+)/)
    if (run) {
      commands.push({
        kind: 'run',
        script: run[1],
        command: `pnpm run ${run[1]}`,
      })
    }
    if (/(?:^|\n)\s*(?:pnpm|npm)\s+install\b/.test(executable)) {
      commands.push({
        kind: 'install',
        script: 'preinstall',
        command: 'pnpm install --frozen-lockfile',
      })
    }
    const nodeScript = executable.match(/(?:^|\n)\s*(node\s+scripts\/\S+)/)
    if (nodeScript) {
      commands.push({
        kind: 'node',
        script: nodeScript[1],
        command: nodeScript[1],
      })
    }
  }
  return commands
}

function eventMatches(workflow, event) {
  const on = workflow.on
  if (on == null || typeof on !== 'object' || Array.isArray(on)) return false
  const filter = on[event.name]
  if (filter == null && !Object.prototype.hasOwnProperty.call(on, event.name)) {
    return false
  }
  if (event.name === 'push') {
    const branches = asList(filter?.branches)
    if (branches.length === 0) return true
    return filterMatches(branches, event.branch)
  }
  if (event.name === 'pull_request') {
    const branches = asList(filter?.branches)
    if (branches.length === 0) return true
    return filterMatches(branches, event.branch)
  }
  return false
}

function resolveEnv(map, event) {
  const resolved = {}
  if (map == null) return resolved
  for (const [key, value] of Object.entries(map)) {
    resolved[key] = resolveExpressions(String(value), event)
  }
  return resolved
}

function resolveExpressions(value, event) {
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_all, expression) => {
    const secret = expression.match(/^secrets\.([A-Za-z0-9_]+)$/)
    if (secret) {
      if (secret[1] !== 'GITHUB_TOKEN' && event.fork) return ''
      if (secret[1] === 'GITHUB_TOKEN') return PLACEHOLDER_TOKEN
      if (secret[1] === 'NX_CLOUD_ACCESS_TOKEN') return PLACEHOLDER_NX
      return `PLACEHOLDER_SECRET_${secret[1]}`
    }
    return ''
  })
}

function normalizePermissions(value) {
  if (value == null) return {}
  if (value === 'read-all' || value === 'write-all') {
    const level = value === 'write-all' ? 'write' : 'read'
    return Object.fromEntries(
      ['contents', 'pull-requests', 'id-token', 'issues'].map((name) => [
        name,
        name === 'id-token' && level === 'read' ? 'none' : level,
      ]),
    )
  }
  const permissions = {}
  for (const name of ['contents', 'pull-requests', 'id-token', 'issues']) {
    permissions[name] = 'none'
  }
  if (typeof value === 'object') {
    for (const [name, level] of Object.entries(value)) {
      permissions[name] = String(level)
    }
  }
  return permissions
}

function evaluateIf(expression, event) {
  if (expression == null || expression === '') return true
  const value = evaluate(stripExpression(String(expression)), {
    github: githubContext(event),
  })
  if (value === 'unknown') return 'unknown'
  return Boolean(value)
}

function stripExpression(expression) {
  const match = expression.trim().match(/^\$\{\{\s*([\s\S]*)\s*\}\}$/)
  return match ? match[1].trim() : expression.trim()
}

function githubContext(event) {
  return {
    repository_owner: event.repositoryOwner,
    ref: event.ref,
    ref_name: event.refName,
    event_name: event.name,
    event: {
      head_commit: { message: event.headCommitMessage },
    },
  }
}

function evaluate(expression, context) {
  function Parser(source) {
    this.source = source
    this.index = 0
  }
  Parser.prototype.done = function () {
    return this.index >= this.source.length
  }
  Parser.prototype.rest = function () {
    return this.source.slice(this.index)
  }
  Parser.prototype.skipSpace = function () {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1
  }
  Parser.prototype.parseOr = function () {
    let left = this.parseAnd()
    for (;;) {
      this.skipSpace()
      if (!this.source.startsWith('||', this.index)) return left
      this.index += 2
      const right = this.parseAnd()
      if (left === true || right === true) left = true
      else if (left === false && right === false) left = false
      else left = 'unknown'
    }
  }
  Parser.prototype.parseAnd = function () {
    let left = this.parseEquality()
    for (;;) {
      this.skipSpace()
      if (!this.source.startsWith('&&', this.index)) return left
      this.index += 2
      const right = this.parseEquality()
      if (left === false || right === false) left = false
      else if (left === true && right === true) left = true
      else left = 'unknown'
    }
  }
  Parser.prototype.parseEquality = function () {
    let left = this.parseUnary()
    for (;;) {
      this.skipSpace()
      const operator = this.source.startsWith('==', this.index)
        ? '=='
        : this.source.startsWith('!=', this.index)
          ? '!='
          : ''
      if (!operator) return left
      this.index += 2
      const right = this.parseUnary()
      if (left === 'unknown' || right === 'unknown') {
        left = 'unknown'
        continue
      }
      const same = String(left) === String(right)
      left = operator === '==' ? same : !same
    }
  }
  Parser.prototype.parseUnary = function () {
    this.skipSpace()
    if (this.source[this.index] === '!') {
      this.index += 1
      const value = this.parseUnary()
      if (value === 'unknown') return 'unknown'
      return !value
    }
    return this.parsePrimary()
  }
  Parser.prototype.parsePrimary = function () {
    this.skipSpace()
    const char = this.source[this.index]
    if (char === '(') {
      this.index += 1
      const value = this.parseOr()
      this.skipSpace()
      if (this.source[this.index] !== ')') {
        throw new Error('missing )')
      }
      this.index += 1
      return value
    }
    if (char === "'" || char === '"') return this.parseString()
    const ident = this.parseIdent()
    if (ident == null) throw new Error(`unsupported expression: ${this.rest()}`)
    if (typeof ident !== 'string') return ident
    this.skipSpace()
    if (this.source[this.index] === '(') return this.parseCall(ident)
    return this.parsePath(ident, context)
  }
  Parser.prototype.parseCall = function (name) {
    this.index += 1
    const args = []
    this.skipSpace()
    if (this.source[this.index] !== ')') {
      for (;;) {
        args.push(this.parseOr())
        this.skipSpace()
        if (this.source[this.index] === ',') {
          this.index += 1
          continue
        }
        break
      }
    }
    if (this.source[this.index] !== ')') throw new Error('missing )')
    this.index += 1
    if (args.some((arg) => arg === 'unknown')) return 'unknown'
    if (name === 'startsWith') return String(args[0]).startsWith(String(args[1]))
    if (name === 'endsWith') return String(args[0]).endsWith(String(args[1]))
    if (name === 'contains') return String(args[0]).includes(String(args[1]))
    return 'unknown'
  }
  Parser.prototype.parsePath = function (root, current) {
    let value = Object.prototype.hasOwnProperty.call(current, root)
      ? current[root]
      : root === 'steps'
        ? 'unknown'
        : undefined
    if (value === undefined) return 'unknown'
    while (this.source[this.index] === '.') {
      this.index += 1
      const key = this.parseProperty()
      if (value === 'unknown') continue
      if (value == null || typeof value !== 'object') return 'unknown'
      value = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : 'unknown'
    }
    return value
  }
  Parser.prototype.parseProperty = function () {
    const match = /^[A-Za-z0-9_-]+/.exec(this.source.slice(this.index))
    if (!match) throw new Error(`missing property in ${this.rest()}`)
    this.index += match[0].length
    return match[0]
  }
  Parser.prototype.parseIdent = function () {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index))
    if (!match) return null
    this.index += match[0].length
    if (match[0] === 'true') return true
    if (match[0] === 'false') return false
    if (match[0] === 'null') return ''
    return match[0]
  }
  Parser.prototype.parseString = function () {
    const quote = this.source[this.index]
    this.index += 1
    let value = ''
    while (!this.done() && this.source[this.index] !== quote) {
      value += this.source[this.index]
      this.index += 1
    }
    this.index += 1
    return value
  }

  const parser = new Parser(expression)
  const value = parser.parseOr()
  parser.skipSpace()
  if (!parser.done()) {
    throw new Error(`unsupported expression remainder: ${parser.rest()}`)
  }
  return value
}

function filterMatches(patterns, name) {
  let included = false
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (patternMatches(pattern.slice(1), name)) included = false
    } else if (patternMatches(pattern, name)) {
      included = true
    }
  }
  return included
}

function patternMatches(pattern, name) {
  return patternToRegExp(pattern).test(name)
}

function patternToRegExp(pattern) {
  const pieces = []
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\') {
      index += 1
      pieces.push(escapeRegExp(pattern[index] ?? ''))
      continue
    }
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        pieces.push('.*')
        index += 1
      } else {
        pieces.push('[^/]*')
      }
      continue
    }
    if (char === '+' || char === '?') {
      const previous = pieces.pop()
      if (previous == null) throw new Error(`dangling ${char} in ${pattern}`)
      pieces.push(`(?:${previous})${char}`)
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index)
      if (end < 0) throw new Error(`unclosed class in ${pattern}`)
      pieces.push(pattern.slice(index, end + 1))
      index = end
      continue
    }
    pieces.push(escapeRegExp(char))
  }
  return new RegExp(`^${pieces.join('')}$`)
}

function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&')
}

function asList(value) {
  if (value == null) return []
  return Array.isArray(value) ? value.map(String) : [String(value)]
}

function loadWorkflow(file) {
  const script = `
import json, sys, yaml
class Loader(yaml.SafeLoader):
    pass
for key, resolvers in list(Loader.yaml_implicit_resolvers.items()):
    Loader.yaml_implicit_resolvers[key] = [
        item for item in resolvers if item[0] != 'tag:yaml.org,2002:bool'
    ]
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    json.dump(yaml.load(handle, Loader), sys.stdout)
`
  const stdout = execFileSync('python3', ['-c', script, file], {
    encoding: 'utf8',
  })
  const workflow = JSON.parse(stdout)
  if (workflow.on == null) {
    throw new Error(`workflow ${file} is missing on`)
  }
  return workflow
}

async function runRepositoryStep(step) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'release-priv-'))
  const runnerTemp = path.join(workspace, 'runner-temp')
  const report = path.join(workspace, 'report.jsonl')
  fs.mkdirSync(runnerTemp)
  try {
    await exec('git', ['init'], { cwd: workspace })
    fs.writeFileSync(path.join(workspace, 'record-exposure.js'), recorderSource())
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'exposure-fixture', private: true, type: 'module' }),
    )
    const env = baseEnv(workspace, runnerTemp, report)
    await exec('corepack', ['pnpm@11.9.0', 'install', '--lockfile-only'], {
      cwd: workspace,
      env,
    })
    const scripts = {
      preinstall: 'node ./record-exposure.js',
      'build:all': 'node ./record-exposure.js',
      'test:pr': 'node ./record-exposure.js',
      'generate-docs': 'node ./record-exposure.js',
      format: 'node ./record-exposure.js',
      'changeset:version': 'node ./record-exposure.js',
      'changeset:publish': 'node ./record-exposure.js',
    }
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        name: 'exposure-fixture',
        private: true,
        type: 'module',
        scripts,
      }),
    )
    fs.mkdirSync(path.join(workspace, 'scripts'))
    fs.writeFileSync(
      path.join(workspace, 'scripts/create-github-release.mjs'),
      recorderSource(),
    )
    if (step.credentialsPersisted) {
      persistCheckoutCredentials(workspace, runnerTemp, PLACEHOLDER_TOKEN)
    }
    const commandEnv = {
      ...env,
      ...nonEmpty(step.env),
    }
    if (step.oidc) {
      commandEnv.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://example.invalid/oidc'
      commandEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN = PLACEHOLDER_OIDC
    }
    const scriptFile = path.join(workspace, 'workflow-step.sh')
    fs.writeFileSync(scriptFile, `${step.command}\n`)
    await exec(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', scriptFile],
      { cwd: workspace, env: commandEnv },
    )
    const lines = fs.readFileSync(report, 'utf8').trim().split('\n').filter(Boolean)
    const observed = lines.map((line) => JSON.parse(line)).reduce(
      (all, line) => ({
        nx: all.nx || line.nx,
        oidc: all.oidc || line.oidc,
        githubTokenEnv: all.githubTokenEnv || line.githubTokenEnv,
        persistedToken: all.persistedToken || line.persistedToken,
      }),
      { nx: false, oidc: false, githubTokenEnv: false, persistedToken: false },
    )
    return observed
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

function nonEmpty(env) {
  const copy = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== '') copy[key] = value
  }
  return copy
}

function baseEnv(workspace, runnerTemp, report) {
  const bin = path.join(workspace, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const shim = path.join(bin, 'pnpm')
  fs.writeFileSync(
    shim,
    `#!/bin/bash\nexec corepack ${pnpmSpec} "$@"\n`,
  )
  fs.chmodSync(shim, 0o755)
  return {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    USER: process.env.USER ?? 'runner',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TMPDIR: runnerTemp,
    RUNNER_TEMP: runnerTemp,
    EXPOSURE_REPORT: report,
    CI: 'true',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  }
}

function persistCheckoutCredentials(workspace, runnerTemp, token) {
  const gitDir = path.join(workspace, '.git').replace(/\\/g, '/')
  const credentialsPath = path.join(
    runnerTemp,
    `git-credentials-${crypto.randomUUID()}.config`,
  )
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  const placeholder = 'AUTHORIZATION: basic ***'
  const header = `AUTHORIZATION: basic ${basic}`
  execFileSyncGit([
    'config',
    '--file',
    credentialsPath,
    'http.https://github.com/.extraheader',
    placeholder,
  ])
  const written = fs.readFileSync(credentialsPath, 'utf8')
  if (!written.includes(placeholder) || written.indexOf(placeholder) !== written.lastIndexOf(placeholder)) {
    throw new Error('credential placeholder was not written once')
  }
  fs.writeFileSync(credentialsPath, written.replace(placeholder, header))
  execFileSyncGit(
    ['config', '--local', `includeIf.gitdir:${gitDir}.path`, credentialsPath],
    workspace,
  )
  execFileSyncGit(
    [
      'config',
      '--local',
      `includeIf.gitdir:${gitDir}/worktrees/*.path`,
      credentialsPath,
    ],
    workspace,
  )
}

function execFileSyncGit(args, cwd) {
  execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function recorderSource() {
  return `
import fs from 'node:fs'
import path from 'node:path'
const report = process.env.EXPOSURE_REPORT
const configPath = path.join(process.cwd(), '.git', 'config')
let persistedToken = false
if (fs.existsSync(configPath)) {
  const config = fs.readFileSync(configPath, 'utf8')
  const credentialPaths = [...config.matchAll(/^\\s*path\\s*=\\s*(.+)\\s*$/gm)].map((match) => match[1].trim())
  for (const credentialPath of credentialPaths) {
    if (!fs.existsSync(credentialPath)) continue
    const text = fs.readFileSync(credentialPath, 'utf8')
    const header = text.match(/AUTHORIZATION: basic ([A-Za-z0-9+/=]+)/)
    if (!header) continue
    const decoded = Buffer.from(header[1], 'base64').toString('utf8')
    if (decoded.startsWith('x-access-token:')) persistedToken = true
  }
}
fs.appendFileSync(report, JSON.stringify({
  nx: Boolean(process.env.NX_CLOUD_ACCESS_TOKEN),
  oidc: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
  githubTokenEnv: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
  persistedToken,
}) + '\\n')
`
}
