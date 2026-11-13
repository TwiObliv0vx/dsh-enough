/**
 * dsh-enough preset-hook test — no DSH runtime required.
 *
 * Exercises the `internal/config` rewrite against a composition shaped like the
 * shipped `preset-standard` row, and the preset-side summarizer install on a
 * fake engine.
 *
 * Run: node test/hook.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-enough-hook-'))
process.env.DSH_ENOUGH_HOME = home

const { installPresetHook, rewriteComposition, hookState, describePresetHook } = await import('../lib/preset-hook.js')
const { apply: applyHandoff } = await import('../lib/preset-handoff.js')

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error?.message ?? String(error)])
  }
}

const COMPACTION = '@deepseek-ai/dsh-compaction-basic'

/** A composition shaped like the shipped standard preset. */
function presetComposition() {
  return {
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true },
        config: [
          { id: 'compaction-basic', name: COMPACTION },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        ],
      },
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
    ],
  }
}

const listeners = new Map()
const ctx = {
  on(event, handler, options) {
    listeners.set(event, { handler, options })
  },
  logger: { info() {}, warn() {} },
}

let liveConfig = { presetHandoff: true, compactThresholdRatio: 0.72 }
const installed = installPresetHook(ctx, () => liveConfig)

check('hook installs', () => assert.equal(installed.ok, true))
check('hook is idempotent', () => {
  const again = installPresetHook(ctx, () => liveConfig)
  assert.equal(again.already, true)
})
check('listens on internal/config globally', () => {
  const entry = listeners.get('internal/config')
  assert.ok(entry, 'no listener')
  assert.equal(entry.options?.global, true)
})

const fire = (config) => listeners.get('internal/config').handler({}, () => config)

// ---- the rewrite ---------------------------------------------------------
const source = presetComposition()
const rewritten = fire(source)

check('returns a new composition', () => assert.notEqual(rewritten, source))
check('threshold written into the engine row', () => {
  const row = rewritten.plugins[1].config.find((c) => c.name === COMPACTION)
  assert.equal(row.config.thresholdRatio, 0.72)
})
check('handoff row appended inside the group', () => {
  const group = rewritten.plugins[1]
  const last = group.config[group.config.length - 1]
  assert.equal(last.id, 'enough-handoff')
  assert.match(last.name, /preset-handoff\.js$/)
})
check('handoff row sits beside the engine, not at top level', () => {
  assert.equal(rewritten.plugins.some((p) => p.id === 'enough-handoff'), false)
})
check('source composition left untouched', () => {
  assert.equal(source.plugins[1].config.length, 2)
  assert.equal(source.plugins[1].config[0].config, undefined)
})
check('re-running on its own output does not duplicate', () => {
  const twice = fire(rewritten)
  const group = twice.plugins[1]
  assert.equal(group.config.filter((c) => c.id === 'enough-handoff').length, 1)
})

// ---- guards --------------------------------------------------------------
check('host-plane top-level engine row untouched', () => {
  const host = { plugins: [{ id: 'compaction-basic', name: COMPACTION }] }
  const out = fire(host)
  assert.equal(out, host)
  assert.equal(out.plugins.length, 1)
  assert.equal(out.plugins[0].config, undefined)
})
check('composition without an engine row is returned as-is', () => {
  const plain = { plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] }
  assert.equal(fire(plain), plain)
})
check('missing plugins list is tolerated', () => {
  assert.deepEqual(fire({}), {})
})
check('presetHandoff false leaves everything alone', () => {
  const saved = liveConfig
  liveConfig = { ...saved, presetHandoff: false }
  const before = presetComposition()
  assert.equal(fire(before), before)
  liveConfig = saved
})
check('invalid ratio leaves the engine threshold alone but still installs', () => {
  const saved = liveConfig
  liveConfig = { ...saved, compactThresholdRatio: 1.7 }
  const out = fire(presetComposition())
  const row = out.plugins[1].config.find((c) => c.name === COMPACTION)
  assert.equal(row.config.thresholdRatio, undefined)
  assert.ok(out.plugins[1].config.some((c) => c.id === 'enough-handoff'))
  liveConfig = saved
})
check('rewriteComposition is pure for foreign configs', () => {
  const foreign = { plugins: [{ id: 'x', name: 'who-knows' }] }
  assert.equal(rewriteComposition(foreign, { threshold: 0.5 }), foreign)
})
check('state reports work done', () => {
  const snapshot = hookState()
  assert.ok(snapshot.patched >= 1, `patched=${snapshot.patched}`)
  assert.ok(snapshot.appended >= 1, `appended=${snapshot.appended}`)
  assert.match(describePresetHook(), /^on · \d+\/\d+ compositions patched/)
})

// ---- the preset-side summarizer install ----------------------------------
function fakeEngine() {
  return {
    constructor: { name: 'BasicCompactionEngine' },
    summarize() {
      return 'original-summary'
    },
  }
}

check('preset plugin patches the engine summarizer', () => {
  const engine = fakeEngine()
  const original = engine.summarize
  applyHandoff({ compaction: engine, logger: { info() {}, warn() {} } })
  assert.notEqual(engine.summarize, original)
  assert.equal(engine.__enoughPatched, true)
})
check('preset plugin is idempotent', () => {
  const engine = fakeEngine()
  const pctx = { compaction: engine, logger: { info() {}, warn() {} } }
  applyHandoff(pctx)
  const patched = engine.summarize
  applyHandoff(pctx)
  assert.equal(engine.summarize, patched)
})
check('preset plugin stays passive without an engine', () => {
  const pctx = { logger: { info() {}, warn() {} } }
  applyHandoff(pctx)
  assert.equal(pctx.compaction, undefined)
})
check('presetHandoff false falls back to the original summarizer', () => {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ presetHandoff: false }), 'utf8')
  const engine = fakeEngine()
  applyHandoff({ compaction: engine, logger: { info() {}, warn() {} } })
  assert.equal(engine.summarize(), 'original-summary')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ presetHandoff: true }), 'utf8')
})

// ---- report --------------------------------------------------------------
let failed = 0
for (const [status, name, detail] of results) {
  if (status === 'FAIL') failed += 1
  console.log(`${status === 'PASS' ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
