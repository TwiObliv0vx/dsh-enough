/**
 * dsh-enough — the preset-side half of the handoff takeover.
 *
 * `preset-hook.js` appends a row with this module *inside* the agent preset's
 * isolated compaction group, so it runs in the same realm as
 * `@deepseek-ai/dsh-compaction-basic`. That is the only place where
 * `ctx.compaction` is visible: the engine is isolated per preset, not shared on
 * the Host plane.
 *
 * Installing here replaces the engine's generic summarizer with the handoff
 * brief from `summarize.js`. It is idempotent and reversible: the original
 * method is kept on the engine as `__enoughOriginal`.
 */
import { loadConfig } from './config.js'
import { summarizeEnough } from './summarize.js'

export const name = 'dsh-enough-handoff'
/** The engine only exists inside the preset realm, so wait for it there. */
export const inject = ['compaction']

const PATCHED = '__enoughPatched'
const ORIGINAL = '__enoughOriginal'

export function apply(ctx) {
  const engine = ctx?.compaction
  if (!engine || typeof engine.summarize !== 'function') {
    ctx?.logger?.warn?.('dsh-enough: preset handoff found no compaction engine; staying passive')
    return
  }
  if (engine[PATCHED]) return

  const original = engine.summarize
  engine[ORIGINAL] = original
  engine.summarize = function enoughSummarize(input, agent, signal) {
    const config = loadConfig()
    if (config.presetHandoff === false) return original.call(this, input, agent, signal)
    return summarizeEnough(this?.ctx ?? ctx, config, input, agent, signal)
  }
  engine[PATCHED] = true
  ctx?.logger?.info?.('dsh-enough: handoff summarizer installed in the preset realm')
}
