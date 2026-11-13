/**
 * dsh-enough smoke test — no DSH runtime required.
 *
 * Mocks the Cordis context surface the plugin touches, then exercises:
 * tool registration + execution, the `/enough` command, coexist/takeover
 * summarizer swapping, and the handoff summarizer against a fake stream.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-enough-smoke-'))
process.env.DSH_ENOUGH_HOME = home

const { apply } = await import('../lib/index.js')
const { summarizeEnough, buildTranscript } = await import('../lib/summarize.js')
const { describeFile, formatFileIndex } = await import('../lib/indexer.js')
const { loadConfig } = await import('../lib/config.js')

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error?.message ?? String(error)])
  }
}

// ---- fake cordis context -------------------------------------------------
const tools = []
const commands = []
const listeners = new Map()
const routes = []
let originalSumm = null
const engine = {
  constructor: { name: 'BasicCompactionEngine' },
  summarize(input, agent, signal) {
    return 'original-summary'
  },
  async compactNow() {
    return { shadowedSeqs: [1, 2] }
  },
}
originalSumm = engine.summarize

const ctx = {
  get(name) {
    return name === 'compaction' ? engine : undefined
  },
  tools: { register: (tool) => tools.push(tool) },
  commands: { register: (cmd) => (commands.push(cmd), () => {}) },
  effect(fn) {
    const out = fn()
    if (out && typeof out.next === 'function') {
      let step = out.next()
      while (!step.done) step = out.next()
    }
    return typeof out === 'function' ? out : () => {}
  },
  on(event, handler) {
    listeners.set(event, handler)
  },
  logger: { info() {}, warn() {} },
  webServer: { register: (route) => (routes.push(route), () => {}) },
  llm: {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '## 原始任务\n测试任务' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}

apply(ctx, { mode: 'coexist' })

check('registers 2 tools', () => assert.equal(tools.length, 2))
check('registers /enough', () => assert.equal(commands.length, 1))
check('command name is enough', () => assert.equal(commands[0].name, 'enough'))
check('coexist leaves summarizer alone', () => assert.equal(engine.summarize, originalSumm))

const statusTool = tools.find((t) => t.name === 'enough_status')
const indexTool = tools.find((t) => t.name === 'context_index')
check('status tool exists', () => assert.ok(statusTool))
check('index tool exists', () => assert.ok(indexTool))

const status = await statusTool.execute({}, {})
check('status mode coexist', () => assert.equal(status.mode, 'coexist'))
check('status handoff off', () => assert.equal(status.handoffInstalled, false))
check('status schema keys present', () => {
  for (const key of statusTool.output.schema.required) assert.ok(key in status, `missing ${key}`)
})

// indexer
const fixture = join(home, 'fixture.md')
writeFileSync(
  fixture,
  ['# Title', '', 'intro', '', '## Section A', 'alpha line', '', '## Section B', 'beta line', ''].join('\n'),
  'utf8',
)
const info = describeFile(fixture)
check('indexer finds 3 sections', () => assert.equal(info.sections.length, 3))
check('indexer line ranges', () => assert.equal(info.sections[1].start, 5))
check('indexer formats markdown', () => assert.ok(formatFileIndex(info).includes('L5')))
const idx = await indexTool.execute({ path: fixture }, {})
check('index tool ok', () => assert.equal(idx.ok, true))
check('index tool sections', () => assert.equal(idx.sections, 3))
const noArg = await indexTool.execute({}, {})
check('index tool rejects empty', () => assert.equal(noArg.ok, false))

// command: status / takeover / coexist / sac
const run = (raw) => commands[0].handler({ rawInput: raw })
const statusRes = await run('status')
check('status command', () => assert.equal(statusRes.kind, 'success'))
const tk = await run('mode takeover')
check('takeover success', () => assert.equal(tk.kind, 'success'))
check('takeover swaps summarizer', () => assert.notEqual(engine.summarize, originalSumm))
check('takeover persists mode', () => assert.equal(loadConfig().mode, 'takeover'))
const st2 = await statusTool.execute({}, {})
check('status sees handoff installed', () => assert.equal(st2.handoffInstalled, true))
const co = await run('mode coexist')
check('coexist restores', () => assert.equal(co.kind, 'success'))
check('coexist restores summarizer', () => assert.equal(engine.summarize, originalSumm))
check('coexist persists mode', () => assert.equal(loadConfig().mode, 'coexist'))

const sacOn = await run('sac on')
check('sac command', () => assert.equal(sacOn.kind, 'success'))
check('sac persists', () => assert.equal(loadConfig().sac, true))
const sacOff = await run('sac off')
check('sac off', () => assert.equal(sacOff.kind, 'success'))
const badMode = await run('mode nope')
check('bad mode rejected', () => assert.equal(badMode.kind, 'error'))
const badSub = await run('wat')
check('unknown subcommand rejected', () => assert.equal(badSub.kind, 'error'))

// settings route: GET returns config, POST saves and flips mode
check('registers one route', () => assert.equal(routes.length, 1))
check('route path', () => assert.equal(routes[0].path, '/enough/api/config'))

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(text) {
      this.body = text
    },
  }
}

const getRes = makeRes()
await routes[0].handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, getRes)
const getBody = JSON.parse(getRes.body)
check('GET ok', () => assert.equal(getBody.ok, true))
check('GET has config', () => assert.equal(typeof getBody.config.mode, 'string'))

const postRes = makeRes()
await routes[0].handler(
  {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ mode: 'takeover', summaryMaxTokens: 2048 }))
    },
  },
  postRes,
)
const postBody = JSON.parse(postRes.body)
check('POST saves mode', () => assert.equal(postBody.config.mode, 'takeover'))
check('POST installed handoff', () => assert.equal(postBody.config.handoffInstalled, true))
check('POST saves summaryMaxTokens', () => assert.equal(postBody.config.summaryMaxTokens, 2048))
check('POST persisted to file', () => assert.equal(loadConfig().mode, 'takeover'))

const denyRes = makeRes()
await routes[0].handler({ method: 'GET', socket: { remoteAddress: '10.0.0.9' } }, denyRes)
check('route denies non-loopback', () => assert.equal(denyRes.statusCode, 403))

// restore mode for the summarizer section below
await run('mode coexist')

// summarizer against the fake stream
const transcript = buildTranscript([
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'world' }, { type: 'tool-call', name: 'read', arguments: '{}' }] },
])
check('transcript includes roles', () => assert.ok(transcript.includes('[user]') && transcript.includes('[tool-call] read')))
const summary = await summarizeEnough(
  ctx,
  { summaryMaxTokens: 4000 },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'old context' }] }] },
  { session: { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} },
  undefined,
)
check('summary shape', () => assert.ok(Array.isArray(summary.summary) && summary.summary[0].type === 'text'))
check('summary text', () => assert.ok(summary.summary[0].text.includes('原始任务')))

// engine-absent profile (e.g. billion-context disabled compaction-basic):
// takeover must be refused AND must not be persisted.
{
  const tools2 = []
  const commands2 = []
  const ctx2 = {
    get: () => undefined,
    tools: { register: (t) => tools2.push(t) },
    commands: { register: (c) => (commands2.push(c), () => {}) },
    effect(fn) {
      const out = fn()
      if (out && typeof out.next === 'function') {
        let s = out.next()
        while (!s.done) s = out.next()
      }
      return typeof out === 'function' ? out : () => {}
    },
    on() {},
    logger: { info() {}, warn() {} },
    webServer: { register: () => () => {} },
    llm: { async *stream() {} },
  }
  apply(ctx2, { mode: 'coexist' })
  const run2 = (raw) => commands2[0].handler({ rawInput: raw })
  const res2 = await run2('mode takeover')
  check('takeover refused without engine', () => assert.equal(res2.kind, 'error'))
  check('refused takeover not persisted', () => assert.equal(loadConfig().mode, 'coexist'))
  const st3 = await tools2.find((t) => t.name === 'enough_status').execute({}, {})
  check('status reports engine absent', () => assert.equal(st3.engine, 'absent'))
}

// restore engine for cleanliness
engine.summarize = originalSumm

rmSync(home, { recursive: true, force: true })

const failed = results.filter(([s]) => s === 'FAIL')
for (const [status, name, detail] of results) {
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
