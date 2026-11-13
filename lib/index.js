/**
 * dsh-enough — "You don't need long context" for DeepSeek Harness.
 *
 * Three pieces, one plugin:
 *
 * 1. Handoff compaction (required). Swaps the live compaction engine's
 *    summarizer for a task-handoff brief, so when pressure compacts the
 *    conversation the replacement is a brief a fresh agent can continue from
 *    (task / done / progress / next / facts / open questions) instead of a
 *    generic conversation summary.
 *
 * 2. Selective long-input reading (required). `context_index` turns a big
 *    file or directory into a line-ranged index so the agent reads only the
 *    slice it needs instead of pasting everything into the window.
 *
 * 3. Single-action compaction (optional, off by default). Each time an agent
 *    goes idle, compact once so only the semantic state survives. Enable with
 *    `/enough sac on`.
 *
 * Modes: `coexist` (default) registers tools/command only and leaves the
 * compaction backend untouched; `takeover` installs the handoff summarizer at
 * runtime. Both are reversible without restart.
 */
import { configPath, loadConfig, saveConfig } from './config.js'
import { describeFile, formatDirectoryScan, formatFileIndex, scanDirectory } from './indexer.js'
import { summarizeEnough } from './summarize.js'

export const name = 'dsh-enough'
/**
 * `compaction` is deliberately NOT injected: a profile may run without the
 * built-in compaction service (another plugin can disable or replace it), and
 * injecting a dependency that never registers would leave this plugin pending
 * forever. The engine is looked up lazily via ctx.get() instead, and the plugin
 * degrades to coexist mode when it is absent.
 */
export const inject = ['tools', 'commands', 'webServer']

const API = '/enough/api'

const PATCHED = '__enoughPatched'
const ORIGINAL = '__enoughOriginal'
const SAC_FLAG = '__enoughSac'

function patchDefaults(patchConfig) {
  return patchConfig && typeof patchConfig === 'object' && !Array.isArray(patchConfig) ? patchConfig : {}
}

function getEngine(ctx) {
  try {
    return ctx.get('compaction') ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- http (settings page)

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function isLoopback(req) {
  const addr = req?.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Compaction-engine limits are owned by the engine (it freezes its config at
 * startup), not by this plugin. Read them defensively; null means unknown.
 */
function engineLimits(engine) {
  let config = null
  try {
    config = engine?.config ?? null
  } catch {
    config = null
  }
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return {
    thresholdRatio: num(config?.thresholdRatio),
    retainRatio: num(config?.retainRatio),
  }
}

function publicStatus(ctx, patchConfig) {
  const cfg = loadConfig(patchConfig)
  const engine = getEngine(ctx)
  const limits = engineLimits(engine)
  return {
    mode: cfg.mode,
    sac: Boolean(cfg.sac),
    summaryMaxTokens: Number(cfg.summaryMaxTokens),
    indexMinBytes: Number(cfg.indexMinBytes),
    indexMaxFiles: Number(cfg.indexMaxFiles),
    engineThresholdRatio: limits.thresholdRatio,
    engineRetainRatio: limits.retainRatio,
    handoffInstalled: Boolean(engine && engine[PATCHED]),
    engine: engine ? engine.constructor?.name ?? 'present' : 'absent',
    configPath: configPath(),
  }
}

function registerRoutes(ctx, patchConfig) {
  return ctx.webServer.register({
    kind: 'exact',
    path: `${API}/config`,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        json(res, 403, { ok: false, error: 'loopback access only' })
        return
      }
      if (req.method === 'GET') {
        json(res, 200, { ok: true, config: publicStatus(ctx, patchConfig) })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body = {}
      try {
        const raw = await readBody(req)
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = {}
      }
      const patch = {}
      if (body.mode === 'coexist' || body.mode === 'takeover') patch.mode = body.mode
      if (typeof body.sac === 'boolean') patch.sac = body.sac
      const summaryTokens = Number(body.summaryMaxTokens)
      if (Number.isFinite(summaryTokens) && summaryTokens >= 256) patch.summaryMaxTokens = Math.floor(summaryTokens)
      const minBytes = Number(body.indexMinBytes)
      if (Number.isFinite(minBytes) && minBytes >= 0) patch.indexMinBytes = Math.floor(minBytes)
      const maxFiles = Number(body.indexMaxFiles)
      if (Number.isFinite(maxFiles) && maxFiles > 0) patch.indexMaxFiles = Math.floor(maxFiles)
      // Mode first: a failed takeover must not be persisted.
      if (patch.mode === 'takeover') {
        const installed = installHandoff(ctx, patchConfig)
        if (!installed.ok) {
          json(res, 409, { ok: false, error: installed.reason, config: publicStatus(ctx, patchConfig) })
          return
        }
      } else if (patch.mode === 'coexist') {
        uninstallHandoff(ctx)
      }
      saveConfig(patch)
      if (patch.sac === true) installSac(ctx, patchConfig)
      json(res, 200, { ok: true, config: publicStatus(ctx, patchConfig) })
    },
  })
}

/** Replace the compaction engine's summarizer with the handoff brief. Idempotent. */
function installHandoff(ctx, patchConfig) {
  const engine = getEngine(ctx)
  if (!engine || typeof engine.summarize !== 'function') {
    return {
      ok: false,
      reason:
        'The compaction service (ctx.compaction) is not registered in this profile. Another plugin may have disabled or replaced @deepseek-ai/dsh-compaction-basic — switch that compressor back to the built-in one before taking over, or stay in coexist mode (context_index and /enough keep working).',
    }
  }
  if (engine[PATCHED]) return { ok: true, already: true }
  const original = engine.summarize
  engine[ORIGINAL] = original
  engine.summarize = function enoughSummarize(input, agent, signal) {
    const cfg = loadConfig(patchConfig)
    return summarizeEnough(this.ctx ?? ctx, cfg, input, agent, signal)
  }
  engine[PATCHED] = true
  return { ok: true, already: false }
}

/** Restore the original summarizer. Idempotent. */
function uninstallHandoff(ctx) {
  const engine = getEngine(ctx)
  if (!engine || !engine[PATCHED]) return { ok: true, noop: true }
  if (typeof engine[ORIGINAL] === 'function') engine.summarize = engine[ORIGINAL]
  engine[PATCHED] = false
  return { ok: true }
}

/** Optional single-action compaction: compact once whenever an agent goes idle. */
function installSac(ctx, patchConfig) {
  if (ctx[SAC_FLAG]) return
  ctx[SAC_FLAG] = true
  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status !== 'idle' || !agent) return
    const cfg = loadConfig(patchConfig)
    if (!cfg.sac) return
    const engine = getEngine(ctx)
    if (!engine || typeof engine.compactNow !== 'function') return
    const controller = new AbortController()
    Promise.resolve(engine.compactNow(agent, controller.signal))
      .then((result) => {
        if (result) ctx.logger?.info?.(`dsh-enough SAC: compacted ${result.shadowedSeqs.length} nodes`)
      })
      .catch((error) => {
        ctx.logger?.warn?.(`dsh-enough SAC skipped: ${error?.message ?? error}`)
      })
  })
}

function applyMode(ctx, patchConfig) {
  const cfg = loadConfig(patchConfig)
  if (cfg.mode === 'takeover') {
    const installed = installHandoff(ctx, patchConfig)
    if (!installed.ok) ctx.logger?.warn?.(`dsh-enough: takeover requested but ${installed.reason}`)
  } else {
    uninstallHandoff(ctx)
  }
  if (cfg.sac) installSac(ctx, patchConfig)
}

// ---------------------------------------------------------------- tools

function makeStatusTool(ctx, patchConfig) {
  return {
    name: 'enough_status',
    description:
      'Show dsh-enough status: mode (coexist/takeover), whether the handoff summarizer is installed on the compaction engine, the SAC toggle, and the config file path.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'sac', 'handoffInstalled', 'configPath'],
        properties: {
          mode: { type: 'string' },
          sac: { type: 'boolean' },
          handoffInstalled: { type: 'boolean' },
          engine: { type: 'string' },
          engineThresholdRatio: { type: 'number' },
          engineRetainRatio: { type: 'number' },
          summaryMaxTokens: { type: 'integer' },
          configPath: { type: 'string' },
        },
      },
      render(_args, value) {
        const limits =
          value.engineThresholdRatio == null && value.engineRetainRatio == null
            ? 'engine limits: unknown'
            : `engine limits: threshold=${value.engineThresholdRatio ?? '—'} · retain=${value.engineRetainRatio ?? '—'}`
        return [
          {
            type: 'text',
            text: [
              `dsh-enough · mode=${value.mode} · handoff=${value.handoffInstalled ? 'installed' : 'off'}`,
              `SAC=${value.sac ? 'on' : 'off'} · summaryMaxTokens=${value.summaryMaxTokens}`,
              limits,
              `engine=${value.engine}`,
              `config=${value.configPath}`,
            ].join('\n'),
          },
        ]
      },
    },
    presentCall() {
      return { card: 'generic', title: 'dsh-enough status', kind: 'other', rawInput: {} }
    },
    async execute() {
      const cfg = loadConfig(patchConfig)
      const engine = getEngine(ctx)
      const limits = engineLimits(engine)
      return {
        mode: cfg.mode,
        sac: Boolean(cfg.sac),
        handoffInstalled: Boolean(engine && engine[PATCHED]),
        engine: engine ? (engine.constructor?.name ?? 'present') : 'absent',
        engineThresholdRatio: limits.thresholdRatio ?? undefined,
        engineRetainRatio: limits.retainRatio ?? undefined,
        summaryMaxTokens: Number(cfg.summaryMaxTokens),
        configPath: configPath(),
      }
    },
  }
}

function makeIndexTool(patchConfig) {
  return {
    name: 'context_index',
    description:
      'Index a large text file or a directory instead of reading it whole: returns line-ranged sections (Markdown headings) with a one-line hint each, so you can read only the slice you need with read(offset, limit). Use it whenever a file is bigger than a few thousand lines or you are about to paste a long document into the conversation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to index, absolute or workspace-relative' },
        dir: { type: 'string', description: 'Directory to scan for large text files (instead of path)' },
        recursive: { type: 'boolean', description: 'With dir: scan subdirectories (default true)' },
        minBytes: { type: 'integer', description: 'With dir: only report files at least this big (default 24000)' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'kind', 'markdown'],
        properties: {
          ok: { type: 'boolean' },
          kind: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          lines: { type: 'integer' },
          sections: { type: 'integer' },
          files: { type: 'integer' },
          markdown: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.markdown || value.hint || '' }]
      },
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Context index',
        kind: 'other',
        rawInput: { path: args.path ?? args.dir ?? '' },
      }
    },
    async execute(args) {
      const cfg = loadConfig(patchConfig)
      const target = String(args.path ?? '').trim()
      const dir = String(args.dir ?? '').trim()
      if (!target && !dir) {
        return {
          ok: false,
          kind: 'error',
          markdown: 'Provide either path (single file) or dir (directory).',
          hint: 'example: context_index({"path":"docs/handbook.md"})',
        }
      }
      if (dir) {
        const scan = scanDirectory(dir, {
          recursive: args.recursive !== false,
          minBytes: Number.isFinite(Number(args.minBytes)) ? Number(args.minBytes) : Number(cfg.indexMinBytes),
          maxFiles: Number(cfg.indexMaxFiles) || 200,
        })
        return {
          ok: true,
          kind: 'dir',
          path: scan.root,
          files: scan.files.length,
          markdown: formatDirectoryScan(scan),
          hint: 'Pick one file, call context_index({"path":...}) to list its sections, then read by line range.',
        }
      }
      const info = describeFile(target)
      return {
        ok: true,
        kind: 'file',
        path: info.path,
        bytes: info.bytes,
        lines: info.lines ?? 0,
        sections: info.sections.length,
        markdown: formatFileIndex(info),
        hint: 'Use read(offset, limit) for the sections you need; do not read the whole file.',
      }
    },
  }
}

// ---------------------------------------------------------------- command

function describeConfig(cfg, engine) {
  const limits = engineLimits(engine)
  return [
    `mode: ${cfg.mode}${cfg.mode === 'coexist' ? ' (tools + command only; the compaction backend is untouched)' : ' (compaction summaries become handoff briefs)'}`,
    `SAC: ${cfg.sac ? 'on' : 'off'} (compact once per idle step, keep the semantic state only)`,
    `engine limits: threshold=${limits.thresholdRatio ?? 'unknown'} · retain=${limits.retainRatio ?? 'unknown'} (owned by the compaction engine, not by this plugin)`,
    `summaryMaxTokens: ${cfg.summaryMaxTokens}`,
    `config: ${configPath()}`,
  ].join('\n')
}

function makeCommandHandler(ctx, patchConfig) {
  return async (invocation) => {
    const raw = String(invocation?.rawInput ?? '').trim()
    const [sub, ...rest] = raw.split(/\s+/).filter(Boolean)
    const cfg = loadConfig(patchConfig)

    if (!sub || sub === 'status') {
      const engine = getEngine(ctx)
      return {
        kind: 'success',
        text: `${describeConfig(cfg, engine)}\nengine: ${engine ? engine.constructor?.name ?? 'present' : 'absent'} · handoff: ${engine?.[PATCHED] ? 'installed' : 'off'}\n\nusage: /enough [status|mode coexist|mode takeover|sac on|sac off|index <path>]`,
      }
    }

    if (sub === 'mode') {
      const mode = rest[0]
      if (mode !== 'coexist' && mode !== 'takeover') {
        return { kind: 'error', text: 'Usage: /enough mode coexist | /enough mode takeover' }
      }
      if (mode === 'takeover') {
        // Install first: if the engine is absent, the mode must not be persisted,
        // otherwise the next restart would silently keep a takeover that never ran.
        const installed = installHandoff(ctx, patchConfig)
        if (!installed.ok) {
          return {
            kind: 'error',
            text: `takeover failed: ${installed.reason}\ncoexist mode is unaffected — context_index keeps working.`,
          }
        }
        saveConfig({ mode })
        return {
          kind: 'success',
          text: `takeover enabled (runtime, no restart). Compaction now writes a handoff brief instead of a generic summary.\n${describeConfig(loadConfig(patchConfig), getEngine(ctx))}`,
        }
      }
      uninstallHandoff(ctx)
      saveConfig({ mode: 'coexist' })
      return {
        kind: 'success',
        text: `coexist restored: the compaction backend is back to its own summaries.\n${describeConfig(loadConfig(patchConfig), getEngine(ctx))}`,
      }
    }

    if (sub === 'sac') {
      const on = rest[0]
      if (on !== 'on' && on !== 'off') return { kind: 'error', text: 'Usage: /enough sac on | /enough sac off' }
      saveConfig({ sac: on === 'on' })
      if (on === 'on') installSac(ctx, patchConfig)
      return {
        kind: 'success',
        text:
          on === 'on'
            ? 'SAC enabled: every idle step compacts once and keeps the semantic state only.'
            : 'SAC disabled.',
      }
    }

    if (sub === 'index') {
      const target = rest.join(' ').trim()
      if (!target) return { kind: 'error', text: 'usage: /enough index <path>' }
      try {
        const info = describeFile(target)
        return { kind: 'success', text: formatFileIndex(info) }
      } catch (error) {
        return { kind: 'error', text: `index failed: ${error?.message ?? error}` }
      }
    }

    return { kind: 'error', text: 'unknown subcommand. usage: /enough [status|mode|sac|index]' }
  }
}

// ---------------------------------------------------------------- plugin

export function apply(ctx, patchConfig) {
  const defaults = patchDefaults(patchConfig)

  ctx.tools.register(makeStatusTool(ctx, defaults))
  ctx.tools.register(makeIndexTool(defaults))

  const handler = makeCommandHandler(ctx, defaults)
  ctx.effect(function* registerEnoughCommand() {
    yield ctx.commands.register({
      definitionId: 'dsh-enough',
      name: 'enough',
      description: "You don't need long context: status, coexist/takeover mode, optional single-action compaction",
      handler,
    })
  }, 'dsh-enough command lifecycle')

  applyMode(ctx, defaults)

  ctx.effect(() => registerRoutes(ctx, defaults), 'dsh-enough settings route')
}
