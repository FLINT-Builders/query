/**
 * Spec for the pull-request autofix supply-chain bug.
 *
 * These tests fail while `.github/workflows/autofix.yml` checks out a pull
 * request and runs that checkout's package scripts (format, and the setup
 * action's install) before autofix.ci commits the resulting tree. They pass
 * when a pull request cannot change a published package file through those
 * steps.
 *
 * Run: node --test scripts/autofix-untrusted-format.test.js
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publishedRelativePath = 'packages/query-core/src/index.ts'
const originalSource = 'export const published = true\n'
const injectedSource =
  'export const published = true\nexport const injected = true\n'

const setupAction =
  'TanStack/config/.github/setup@e4b48f16568324f76f467aa4c2aac2f05db632c3'
// The pinned composite action's install step. See
// TanStack/config `.github/setup/action.yml` at that commit.
const setupInstallCommand = 'pnpm install --frozen-lockfile'

const gitIdentity = {
  GIT_AUTHOR_NAME: 'Autofix Test',
  GIT_AUTHOR_EMAIL: 'autofix-test@example.com',
  GIT_COMMITTER_NAME: 'Autofix Test',
  GIT_COMMITTER_EMAIL: 'autofix-test@example.com',
  CI: 'true',
  npm_config_update_notifier: 'false',
}

test('a pull request format script must not rewrite a published package file', async () => {
  await assertPullRequestCannotRewritePublishedSource(async (repo) => {
    await writeFile(
      path.join(repo, 'attacker-format.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(publishedRelativePath)}, ${JSON.stringify(injectedSource)})\n`,
    )
    const manifest = JSON.parse(
      await readFile(path.join(repo, 'package.json'), 'utf8'),
    )
    manifest.scripts.format = 'node ./attacker-format.mjs'
    await writeFile(
      path.join(repo, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
  })
})

test('a pull request Prettier plugin loaded by the format script must not rewrite a published package file', async () => {
  await assertPullRequestCannotRewritePublishedSource(async (repo) => {
    await writeFile(
      path.join(repo, 'attacker-plugin.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(publishedRelativePath)}, ${JSON.stringify(injectedSource)})\nexport default { languages: [] }\n`,
    )
    const configPath = path.join(repo, 'prettier.config.js')
    const config = await readFile(configPath, 'utf8')
    const marker = "plugins: ['prettier-plugin-svelte']"
    assert.ok(
      config.includes(marker),
      'the repository Prettier config no longer lists prettier-plugin-svelte where this test edits it',
    )
    await writeFile(
      configPath,
      config.replace(
        marker,
        "plugins: ['prettier-plugin-svelte', './attacker-plugin.mjs']",
      ),
    )
  })
})

test('a pull request install script must not rewrite a published package file before autofix commits', async () => {
  await assertPullRequestCannotRewritePublishedSource(async (repo) => {
    await writeFile(
      path.join(repo, 'attacker-postinstall.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(publishedRelativePath)}, ${JSON.stringify(injectedSource)})\n`,
    )
    const manifest = JSON.parse(
      await readFile(path.join(repo, 'package.json'), 'utf8'),
    )
    manifest.scripts.postinstall = 'node ./attacker-postinstall.mjs'
    await writeFile(
      path.join(repo, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
  })
})

test('an ordinary pull request leaves the published package file unchanged', async () => {
  await assertPullRequestCannotRewritePublishedSource(async (repo) => {
    await writeFile(path.join(repo, 'notes.txt'), 'a documentation note\n')
  })
})

async function assertPullRequestCannotRewritePublishedSource(mutatePullRequest) {
  const checkout = await createPullRequestCheckout(mutatePullRequest)
  const repo = checkout.repo
  try {
    const before = await readFile(path.join(repo, publishedRelativePath))
    const workflow = parseAutofixWorkflow(
      await readFile(path.join(repoRoot, '.github/workflows/autofix.yml'), 'utf8'),
    )
    const headSha = (
      await git(repo, ['rev-parse', 'refs/heads/attacker'])
    ).stdout.trim()
    const baseSha = (await git(repo, ['rev-parse', 'refs/heads/main'])).stdout.trim()
    const mergeSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    const context = pullRequestContext({ headSha, baseSha, mergeSha })

    assert.equal(
      evalExpr(workflow.job.if, context),
      true,
      'the autofix job did not run for this pull_request event',
    )

    const outcome = await runStepsBeforeAutofix(repo, workflow.job.steps, context)
    const payload = outcome.reachedAutofix
      ? await collectAutofixPayload(repo, {
          headSha,
          commitMessage: outcome.commitMessage,
        })
      : null

    const packed = await packQueryCoreSource(
      await readFile(path.join(repo, publishedRelativePath)),
    )
    assert.ok(
      packed.includes('package/src/index.ts'),
      'pnpm pack did not include the published package source the release job publishes',
    )

    const committed = publishedAddition(payload)
    const committedText = committed
      ? Buffer.from(committed.contents, 'base64').toString()
      : null
    assert.equal(
      committedText ?? before.toString(),
      before.toString(),
      'autofix staged a pull-request rewrite of the published package source',
    )
    if (!outcome.reachedAutofix) {
      const onDisk = await readFile(
        path.join(repo, publishedRelativePath),
        'utf8',
      )
      assert.equal(
        onDisk,
        before.toString(),
        'a pull-request script rewrote the published package source',
      )
    }
  } finally {
    await checkout.cleanup()
  }
}

function publishedAddition(payload) {
  return payload?.changes.additions.find(
    (addition) => addition.path === publishedRelativePath,
  )
}

function pullRequestContext({ headSha, baseSha, mergeSha }) {
  return {
    github: {
      workflow: 'autofix.ci',
      event_name: 'pull_request',
      sha: mergeSha,
      ref: 'refs/pull/1/merge',
      repository_owner: 'TanStack',
      event: {
        head_commit: null,
        inputs: null,
        number: 1,
        pull_request: {
          number: 1,
          head: { sha: headSha, ref: 'attacker' },
          base: { sha: baseSha, ref: 'main' },
        },
        repository: { owner: { login: 'TanStack' }, name: 'query' },
      },
    },
  }
}

async function runStepsBeforeAutofix(repo, steps, context) {
  for (const step of steps) {
    if (!evalExpr(step.if, context)) continue
    if (step.uses?.startsWith('actions/checkout@')) {
      const requested = step.with?.ref
        ? substituteExpressions(step.with.ref, context)
        : context.github.sha
      const ref =
        requested === context.github.ref ? context.github.sha : requested
      await git(repo, ['checkout', '--force', ref])
      continue
    }
    if (step.uses === setupAction) {
      const install = await bash(repo, setupInstallCommand)
      if (install !== 0) {
        return { reachedAutofix: false, commitMessage: undefined }
      }
      continue
    }
    if (step.uses?.startsWith('autofix-ci/action@')) {
      return {
        reachedAutofix: true,
        commitMessage: stripQuotes(step.with?.['commit-message'] ?? ''),
      }
    }
    if (step.run) {
      const code = await bash(repo, substituteExpressions(step.run, context))
      if (code !== 0) {
        return { reachedAutofix: false, commitMessage: undefined }
      }
    }
  }
  return { reachedAutofix: false, commitMessage: undefined }
}

/**
 * The git sequence in autofix-ci/action index.dist.js (the file GitHub runs)
 * through the point it builds autofix.json. The upload and POST to
 * api.autofix.ci are not run.
 */
async function collectAutofixPayload(repo, { headSha, commitMessage }) {
  await git(repo, ['reset'])
  await git(repo, ['-c', 'core.fileMode=false', 'add', '--all'])
  const diff = await git(repo, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    '--staged',
    '--no-renames',
  ])
  if (diff.stdout === '') return null
  const changes = diff.stdout.trim().split('\n')
  if (changes.some((filePath) => filePath.includes('.github'))) {
    return null
  }
  await git(repo, ['config', 'user.name', 'autofix.ci'])
  await git(repo, ['config', 'user.email', 'noreply@autofix.ci'])
  await git(repo, ['commit', '--no-verify', '-m', 'autofix'])
  const commit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(repo, ['fetch', '--depth=1', 'origin', headSha])
  await git(repo, ['checkout', '--force', 'FETCH_HEAD'])
  await git(repo, ['cherry-pick', '--no-commit', commit])
  const additions = []
  const deletions = []
  for (const filename of changes) {
    try {
      const contents = await readFile(path.join(repo, filename))
      additions.push({ path: filename, contents: contents.toString('base64') })
    } catch {
      deletions.push({ path: filename })
    }
  }
  return {
    version: 1,
    changes: { additions, deletions },
    failFast: true,
    commitMessage: commitMessage || undefined,
  }
}

async function packQueryCoreSource(sourceBytes) {
  const directory = await mkdtemp(path.join(tmpdir(), 'query-core-pack-'))
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, 'packages/query-core/package.json'),
        'utf8',
      ),
    )
    delete manifest.devDependencies
    await mkdir(path.join(directory, 'src'), { recursive: true })
    await writeFile(
      path.join(directory, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    await writeFile(path.join(directory, 'src/index.ts'), sourceBytes)
    const destination = path.join(directory, 'out')
    await mkdir(destination)
    await execFileAsync(
      'pnpm',
      ['pack', '--pack-destination', destination, '--json'],
      { cwd: directory, env: { ...process.env, ...gitIdentity } },
    )
    const [archive] = await readdir(destination)
    const archivePath = path.join(destination, archive)
    const packed = (await execFileAsync('tar', ['-tzf', archivePath])).stdout
    const member = (
      await execFileAsync('tar', ['-xOzf', archivePath, 'package/src/index.ts'])
    ).stdout
    assert.equal(member, sourceBytes.toString())
    return packed
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

let normalizedBase

async function createPullRequestCheckout(mutatePullRequest) {
  normalizedBase ??= await buildNormalizedBase()
  const directory = await mkdtemp(path.join(tmpdir(), 'autofix-pr-'))
  const origin = path.join(directory, 'origin.git')
  const repo = path.join(directory, 'repo')
  await execFileAsync('git', ['init', '--bare', origin])
  await execFileAsync('git', [
    '-C',
    origin,
    'config',
    'uploadpack.allowReachableSHA1InWant',
    'true',
  ])
  await execFileAsync('git', [
    '-C',
    origin,
    'config',
    'uploadpack.allowAnySHA1InWant',
    'true',
  ])
  await execFileAsync('git', ['clone', normalizedBase, repo], {
    env: { ...process.env, ...gitIdentity },
  })
  await git(repo, ['remote', 'remove', 'origin'])
  await git(repo, ['remote', 'add', 'origin', origin])
  await git(repo, ['push', 'origin', 'HEAD:main'])
  await git(repo, ['checkout', '-b', 'attacker'])
  await mutatePullRequest(repo)
  await git(repo, ['add', '--all'])
  await git(repo, ['commit', '-m', 'pull request'])
  await git(repo, ['push', 'origin', 'attacker'])
  await git(repo, ['checkout', '-b', 'merge-ref', 'main'])
  await git(repo, ['merge', '--no-ff', '--no-commit', 'attacker'])
  await git(repo, ['commit', '-m', 'Merge attacker into main'])
  return {
    repo,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

async function buildNormalizedBase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'autofix-base-'))
  const repo = path.join(directory, 'base')
  await mkdir(repo)
  await git(repo, ['init', '-b', 'main'])
  const rootManifest = JSON.parse(
    await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  )
  const manifest = {
    name: 'root',
    private: true,
    type: 'module',
    packageManager: rootManifest.packageManager,
    scripts: { format: rootManifest.scripts.format },
    devDependencies: {
      prettier: '3.8.1',
      'prettier-plugin-svelte': '3.5.1',
      svelte: '5.55.1',
    },
  }
  await writeFile(
    path.join(repo, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await writeFile(
    path.join(repo, 'prettier.config.js'),
    await readFile(path.join(repoRoot, 'prettier.config.js')),
  )
  await writeFile(path.join(repo, '.gitignore'), 'node_modules\n')
  await mkdir(path.join(repo, 'packages/query-core/src'), { recursive: true })
  await writeFile(
    path.join(repo, publishedRelativePath),
    originalSource,
  )
  await git(repo, ['add', '--all'])
  await git(repo, ['commit', '-m', 'base'])
  await bash(repo, 'pnpm install')
  await bash(repo, 'pnpm run format')
  await git(repo, ['add', '--all'])
  const status = await git(repo, ['status', '--porcelain'])
  if (status.stdout.trim() !== '') {
    await git(repo, ['commit', '-m', 'normalize formatter output'])
  }
  const formatted = await readFile(path.join(repo, publishedRelativePath), 'utf8')
  assert.equal(
    formatted,
    originalSource,
    'the fixture source is not stable under the repository format script',
  )
  return repo
}

function parseAutofixWorkflow(text) {
  const lines = text.split('\n')
  const jobLine = lines.findIndex((line) => line === '  autofix:')
  assert.ok(jobLine >= 0, 'autofix job not found')
  const body = []
  for (let index = jobLine + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() && !line.startsWith(' ')) break
    if (/^  [A-Za-z0-9_-]+:/.test(line)) break
    body.push(line)
  }
  const jobIf = body.find((line) => line.startsWith('    if:'))
  const stepsAt = body.findIndex((line) => line === '    steps:')
  assert.ok(stepsAt >= 0, 'autofix steps not found')
  return {
    job: {
      if: unquote(jobIf ? jobIf.slice('    if:'.length).trim() : ''),
      steps: parseSteps(body.slice(stepsAt + 1)),
    },
  }
}

function parseSteps(lines) {
  const steps = []
  let current = null
  let blockKey = null
  let blockIndent = 0
  const flushBlock = () => {
    if (!current || !blockKey) return
    current[blockKey] = current[blockKey].replace(/\n$/, '')
    blockKey = null
  }
  for (const line of lines) {
    if (blockKey && line.trim() && countIndent(line) > blockIndent) {
      current[blockKey] += `${line.slice(blockIndent + 1)}\n`
      continue
    }
    flushBlock()
    const item = line.match(/^ {6}- (.*)$/)
    if (item) {
      current = { with: {} }
      steps.push(current)
      const rest = item[1]
      const key = rest.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (key) assignStepField(current, key[1], key[2])
      continue
    }
    if (!current) continue
    const field = line.match(/^ {8}([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!field) {
      const withField = line.match(/^ {10}([A-Za-z0-9_-]+):\s*(.*)$/)
      if (withField && current._with) {
        current.with[withField[1]] = unquote(withField[2].trim())
      }
      continue
    }
    if (field[2].trim() === '|' || field[2].trim() === '>') {
      blockKey = field[1] === 'with' ? null : field[1]
      blockIndent = 8
      if (blockKey) current[blockKey] = ''
      current._with = field[1] === 'with'
      continue
    }
    current._with = field[1] === 'with'
    if (field[1] !== 'with') assignStepField(current, field[1], field[2])
  }
  flushBlock()
  return steps
}

function assignStepField(step, key, raw) {
  step[key] = unquote(raw.trim())
}

function countIndent(line) {
  return line.match(/^ */)?.[0].length ?? 0
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function stripQuotes(value) {
  return unquote(value.trim())
}

function substituteExpressions(source, context) {
  return source.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression) => {
    const value = evalExpr(expression, context)
    return value == null ? '' : String(value)
  })
}

function evalExpr(expression, context) {
  if (!expression) return true
  let source = expression.trim()
  if (source.startsWith('${{') && source.endsWith('}}')) {
    source = source.slice(3, -2).trim()
  }
  const parser = new ExpressionParser(source, context)
  const value = parser.parseOr()
  parser.skip()
  if (parser.remaining()) {
    throw new Error(`Could not parse workflow expression: ${expression}`)
  }
  return value
}

class ExpressionParser {
  constructor(source, context) {
    this.source = source
    this.context = context
    this.index = 0
  }

  remaining() {
    return this.index < this.source.length
  }

  skip() {
    while (this.source[this.index] === ' ') this.index += 1
  }

  parseOr() {
    let left = this.parseAnd()
    for (;;) {
      this.skip()
      if (!this.source.startsWith('||', this.index)) return left
      this.index += 2
      const right = this.parseAnd()
      left = truthy(left) || truthy(right)
    }
  }

  parseAnd() {
    let left = this.parseUnary()
    for (;;) {
      this.skip()
      if (!this.source.startsWith('&&', this.index)) return left
      this.index += 2
      const right = this.parseUnary()
      left = truthy(left) && truthy(right)
    }
  }

  parseUnary() {
    this.skip()
    if (this.source[this.index] === '!') {
      this.index += 1
      return !truthy(this.parseUnary())
    }
    return this.parseComparison()
  }

  parseComparison() {
    let left = this.parsePrimary()
    this.skip()
    for (const operator of ['==', '!=']) {
      if (this.source.startsWith(operator, this.index)) {
        this.index += operator.length
        const right = this.parsePrimary()
        const same =
          left == null || right == null
            ? left == null && right == null
            : String(left) === String(right)
        return operator === '==' ? same : !same
      }
    }
    return left
  }

  parsePrimary() {
    this.skip()
    if (this.source[this.index] === '(') {
      this.index += 1
      const value = this.parseOr()
      this.skip()
      if (this.source[this.index] !== ')') {
        throw new Error(`Expected ) in ${this.source}`)
      }
      this.index += 1
      return value
    }
    if (this.source.startsWith('startsWith(', this.index)) {
      this.index += 'startsWith('.length
      const search = this.parseOr()
      this.skip()
      if (this.source[this.index] !== ',') throw new Error('startsWith arguments')
      this.index += 1
      const prefix = this.parseOr()
      this.skip()
      if (this.source[this.index] !== ')') throw new Error('startsWith close')
      this.index += 1
      return String(search ?? '')
        .toLowerCase()
        .startsWith(String(prefix ?? '').toLowerCase())
    }
    if (this.source[this.index] === "'" || this.source[this.index] === '"') {
      const quote = this.source[this.index]
      this.index += 1
      let value = ''
      while (this.source[this.index] && this.source[this.index] !== quote) {
        value += this.source[this.index]
        this.index += 1
      }
      this.index += 1
      return value
    }
    const token = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_.-]*/)
    if (!token) throw new Error(`Unexpected expression at ${this.source.slice(this.index)}`)
    this.index += token[0].length
    if (token[0] === 'true') return true
    if (token[0] === 'false') return false
    if (token[0] === 'null') return null
    return lookup(this.context, token[0])
  }
}

function lookup(context, pathExpression) {
  let current = context
  for (const part of pathExpression.split('.')) {
    if (current == null) return null
    current = current[part]
  }
  return current === undefined ? null : current
}

function truthy(value) {
  return value !== false && value !== 0 && value !== '' && value != null
}

async function bash(cwd, script) {
  try {
    await execFileAsync('bash', ['-e', '-c', script], {
      cwd,
      env: { ...process.env, ...gitIdentity },
    })
    return 0
  } catch (error) {
    return error.code ?? 1
  }
}

async function git(cwd, args) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...gitIdentity },
    })
  } catch (error) {
    const failure = new Error(
      `git ${args.join(' ')} failed: ${error.stderr || error.stdout || error.message}`,
    )
    failure.cause = error
    throw failure
  }
}
