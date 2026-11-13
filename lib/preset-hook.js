/**
 * dsh-enough — install the handoff summarizer inside agent presets.
 *
 * Why this exists: in the current DSH build the compaction engine is mounted
 * inside each agent preset's isolated group
 *
 *     - id: compaction
 *       name: cordis:group
 *       group: true
 *       isolate: { compaction: true, toolResultPruner: true }
 *       config:
 *         - id: compaction-basic
 *           name: '@deepseek-ai/dsh-compaction-basic'
 *
 * so the Host plane cannot reach it with `ctx.get('compaction')` — that lookup
 * returns null and host-level `takeover` silently does nothing.
 *
 * The loader hands every composition its resolved entry list through the
 * global `internal/config` event (the same seam billion-context uses). This
 * module listens there and, for any group that directly mounts
 * `@deepseek-ai/dsh-compaction-basic`:
 *
 *   1. writes our `compactThresholdRatio` into that row's config, and
 *   2. appends one `enough-handoff` row beside the engine, so the preset realm
 *      loads `preset-handoff.js` and swaps the summarizer.
 *
 * Only isolated groups are touched. A top-level compaction row — the Host
 * plane shape — is left exactly as it is, so this can never double-install.
 *
 * Everything is defensive: a missing `next()`, a foreign config shape, or a
 * throw leaves the composition untouched and is reported through
 * `hookState()` for `enough_status`. Without this event the plugin simply
 * degrades to coexist mode.
 */

const COMPACTION = '@deepseek-ai/dsh-compaction-basic'
const HANDOFF_ID = 'enough-handoff'
const HOOKED = '__enoughPresetHook'
const DEFAULT_SPEC = new URL('./preset-handoff.js', import.meta.url).href

const state = {
  installed: false,
  compositions: 0,
  patched: 0,
  appended: 0,
  lastThreshold: null,
  error: null,
}

/** Snapshot of what the hook has done since this process started. */
export function hookState() {
  return { ...state }
}

function isRow(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rowConfig(row) {
  return isRow(row?.config) ? row.config : {}
}

function handoffRow(spec) {
  return { id: HANDOFF_ID, name: spec }
}

/**
 * Rewrite one group that mounts the compaction engine directly: patch the
 * engine's threshold and append the handoff row after its siblings.
 * @returns {{ group: object, changed: boolean }}
 */
function rewriteGroup(group, threshold, spec) {
  const children = Array.isArray(group.config) ? group.config : []
  const mountsCompaction = children.some((child) => isRow(child) && child.name === COMPACTION)
  let changed = false

  const next = children.map((child) => {
    if (!isRow(child)) return child
    if (child.name === COMPACTION) {
      const config = { ...rowConfig(child) }
      if (threshold !== null && config.thresholdRatio !== threshold) {
        config.thresholdRatio = threshold
        changed = true
        state.lastThreshold = threshold
      }
      return { ...child, config }
    }
    if (child.group === true && Array.isArray(child.config)) {
      const nested = rewriteGroup(child, threshold, spec)
      if (nested.changed) {
        changed = true
        return nested.group
      }
    }
    return child
  })

  if (mountsCompaction && !next.some((child) => isRow(child) && child.id === HANDOFF_ID)) {
    next.push(handoffRow(spec))
    state.appended += 1
    changed = true
  }

  return { group: changed ? { ...group, config: next } : group, changed }
}

/** Rewrite a whole composition config. Only isolated (group) rows are touched. */
export function rewriteComposition(config, { threshold = null, spec = DEFAULT_SPEC } = {}) {
  if (!isRow(config) || !Array.isArray(config.plugins)) return config
  let changed = false
  const plugins = config.plugins.map((row) => {
    if (!isRow(row) || row.group !== true || !Array.isArray(row.config)) return row
    const result = rewriteGroup(row, threshold, spec)
    if (!result.changed) return row
    changed = true
    return result.group
  })
  return changed ? { ...config, plugins } : config
}

/** Turn the plugin config into hook options; invalid values mean "leave alone". */
export function hookOptions(readConfig) {
  let cfg = {}
  try {
    cfg = readConfig() ?? {}
  } catch {
    cfg = {}
  }
  const ratio = Number(cfg?.compactThresholdRatio)
  const threshold = Number.isFinite(ratio) && ratio >= 0.1 && ratio < 1 ? ratio : null
  const spec = typeof cfg?.handoffSpec === 'string' && cfg.handoffSpec.trim() ? cfg.handoffSpec.trim() : DEFAULT_SPEC
  return { enabled: cfg?.presetHandoff !== false, threshold, spec }
}

/**
 * Register the global `internal/config` listener.
 * @param {object} ctx cordis context
 * @param {() => object} readConfig reads the live plugin config on each resolution
 */
export function installPresetHook(ctx, readConfig) {
  if (ctx?.[HOOKED]) return { ok: true, already: true }
  if (typeof ctx?.on !== 'function') {
    state.error = 'ctx.on is unavailable'
    return { ok: false, reason: state.error }
  }

  const listener = function enoughPresetConfig(_raw, next) {
    const resolved = typeof next === 'function' ? next() : undefined
    if (!isRow(resolved) || !Array.isArray(resolved.plugins)) return resolved
    try {
      const options = hookOptions(readConfig)
      state.compositions += 1
      if (!options.enabled) return resolved
      const rewritten = rewriteComposition(resolved, options)
      if (rewritten !== resolved) state.patched += 1
      return rewritten
    } catch (error) {
      state.error = String(error?.message ?? error)
      return resolved
    }
  }

  try {
    ctx.on('internal/config', listener, { global: true })
  } catch (error) {
    state.error = String(error?.message ?? error)
    return { ok: false, reason: state.error }
  }

  ctx[HOOKED] = true
  state.installed = true
  return { ok: true }
}

/** One line for `enough_status`; `engine=absent` on its own is no longer the final word. */
export function describePresetHook() {
  if (!state.installed) return `off${state.error ? ` (${state.error})` : ''}`
  const tail = state.error ? ` · last error: ${state.error}` : ''
  const threshold = state.lastThreshold === null ? 'engine default' : String(state.lastThreshold)
  return `on · ${state.patched}/${state.compositions} compositions patched · threshold ${threshold}${tail}`
}
