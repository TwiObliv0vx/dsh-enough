/**
 * dsh-enough — persistent configuration.
 *
 * Stored at `~/.dsh/enough/config.json` (override with DSH_ENOUGH_HOME) so the
 * settings page, the `/enough` command and manual edits all see one value set.
 * A bundle patch supplies the initial fallback; an explicitly saved file wins.
 *
 * This file only holds knobs the plugin itself owns. Compaction-engine limits
 * (thresholdRatio / retainRatio) belong to the engine and are read from it at
 * runtime, never persisted here.
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

function readSaved() {
  if (!existsSync(FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw
  } catch {
    return {}
  }
}

const NUMERIC_KEYS = new Set(['summaryMaxTokens', 'indexMinBytes', 'indexMaxFiles'])

/**
 * Keep only keys this plugin owns, and only values of the right shape.
 * Unknown keys (for example a removed `thresholdRatio`) are dropped so a stale
 * file can never leak engine limits back into our config.
 */
function sanitize(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (raw.mode === 'coexist' || raw.mode === 'takeover') out.mode = raw.mode
  if (typeof raw.sac === 'boolean') out.sac = raw.sac
  for (const key of NUMERIC_KEYS) {
    const value = raw[key]
    if (Number.isFinite(value) && value > 0) out[key] = Math.floor(value)
  }
  return out
}

/**
 * Load the effective configuration.
 * Precedence: saved file > `fallback` (bundle patch) > DEFAULTS.
 */
export function loadConfig(fallback = {}) {
  ensureDir()
  return { ...DEFAULTS, ...sanitize(fallback), ...sanitize(readSaved()) }
}

export function saveConfig(patch) {
  ensureDir()
  const next = { ...DEFAULTS, ...sanitize(readSaved()), ...sanitize(patch) }
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function configPath() {
  return FILE
}
