/**
 * dsh-enough — persistent configuration.
 *
 * Stored at `~/.dsh/enough/config.json` so the settings page, the `/enough`
 * command and manual edits all see the same values. A bundle patch supplies
 * the initial fallback; an explicitly saved file wins over it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.env.DSH_ENOUGH_HOME
  ? join(process.env.DSH_ENOUGH_HOME)
  : join(homedir(), '.dsh', 'enough')
const FILE = join(ROOT, 'config.json')

export const DEFAULTS = Object.freeze({
  /** coexist | takeover */
  mode: 'coexist',
  /** pressure ratio the handoff policy documents (takeover guidance) */
  thresholdRatio: 0.55,
  /** verbatim tail retained when taking over */
  retainRatio: 0.12,
  /** optional single-action compaction */
  sac: false,
  /** max output tokens for one handoff brief */
  summaryMaxTokens: 8000,
  /** files smaller than this are never indexed by context_index */
  indexMinBytes: 24_000,
  /** how many files one context_index scan may report */
  indexMaxFiles: 200,
})

function ensureDir() {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true })
  return ROOT
}

/**
 * Load the effective configuration.
 * Precedence: saved file > `fallback` (bundle patch) > DEFAULTS.
 */
export function loadConfig(fallback = {}) {
  ensureDir()
  if (!existsSync(FILE)) return { ...DEFAULTS, ...(fallback ?? {}) }
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...DEFAULTS, ...(fallback ?? {}) }
    }
    return { ...DEFAULTS, ...(fallback ?? {}), ...raw }
  } catch {
    return { ...DEFAULTS, ...(fallback ?? {}) }
  }
}

export function saveConfig(patch) {
  ensureDir()
  const next = { ...loadConfig(), ...(patch ?? {}) }
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function configPath() {
  return FILE
}
