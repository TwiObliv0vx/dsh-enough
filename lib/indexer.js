/**
 * dsh-enough — long-input indexing.
 *
 * Pure, model-free heuristics: split a file by Markdown headings (or by
 * top-level structural markers for code), report line ranges, and let the
 * agent read only the slice it needs with `read offset/limit` instead of
 * pasting the whole file into the context window.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const TEXT_EXT = new Set([
  '.md', '.mdx', '.txt', '.log', '.csv', '.tsv',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.html', '.htm', '.css', '.scss', '.less',
  '.sh', '.ps1', '.bat', '.cmd', '.sql', '.rs', '.go', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.lua', '.r', '.tex',
])

const MAX_INDEX_BYTES = 8 * 1024 * 1024
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*$/
const HINT_MAX = 110

export function isTextFile(filePath) {
  return TEXT_EXT.has(extname(filePath).toLowerCase())
}

function firstNonHeadingLine(lines, fromIndex) {
  for (let i = fromIndex; i < lines.length && i < fromIndex + 40; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    if (HEADING_RE.test(line)) continue
    return line.length > HINT_MAX ? `${line.slice(0, HINT_MAX)}…` : line
  }
  return ''
}

function kindOf(abs, bytes) {
  if (!isTextFile(abs)) return 'binary'
  if (bytes > MAX_INDEX_BYTES) return 'too-large'
  return 'text'
}

/** Index one file: size, line count, heading sections with line ranges. */
export function describeFile(filePath) {
  const abs = resolve(filePath)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`context_index: not a file: ${abs}`)
  const info = { path: abs, bytes: st.size, ext: extname(abs).toLowerCase() }
  const kind = kindOf(abs, st.size)
  if (kind !== 'text') return { ...info, kind, sections: [] }

  const raw = readFileSync(abs, 'utf8')
  const lines = raw.split(/\r?\n/)
  const sections = []
  let current = null
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADING_RE.exec(lines[i])
    if (!m) continue
    if (current) sections.push(current)
    current = { level: m[1].length, title: m[2], start: i + 1 }
  }
  if (current) sections.push(current)
  for (let i = 0; i < sections.length; i += 1) {
    sections[i].end = i + 1 < sections.length ? sections[i + 1].start - 1 : lines.length
    sections[i].hint = firstNonHeadingLine(lines, sections[i].start)
  }
  return { ...info, kind, lines: lines.length, chars: raw.length, sections }
}

/** List indexable files under a directory, largest first, capped. */
export function scanDirectory(dir, { recursive = true, minBytes = 0, maxFiles = 200, maxDepth = 6 } = {}) {
  const root = resolve(dir)
  const found = []
  const walk = (current, depth) => {
    if (found.length >= maxFiles * 4 || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (recursive) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !isTextFile(full)) continue
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      if (size < minBytes) continue
      found.push({ path: full, bytes: size })
    }
  }
  walk(root, 0)
  found.sort((a, b) => b.bytes - a.bytes)
  return { root, files: found.slice(0, maxFiles), truncated: found.length > maxFiles }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** Render a file index as compact Markdown the model can act on. */
export function formatFileIndex(info) {
  const head = `**${info.path}**  \n${fmtBytes(info.bytes)}${info.lines ? ` · ${info.lines} lines` : ''} · ${info.kind}`
  if (info.kind === 'binary') return `${head}\n\nBinary file — read it with a matching parser instead of context_index.`
  if (info.kind === 'too-large') {
    return `${head}\n\nFile is larger than 8 MB — no full-text index. Locate with grep, then read line ranges.`
  }
  if (info.sections.length === 0) {
    return `${head}\n\nNo Markdown headings. Roughly segmented by blank lines; ${info.lines} lines total — grep a keyword first, then read that range.`
  }
  const rows = info.sections.map(
    (s) => `- L${s.start}–L${s.end}  ${'#'.repeat(s.level)} ${s.title}${s.hint ? `  \n  ${s.hint}` : ''}`,
  )
  return `${head}\n\nSection index (${info.sections.length} sections; read only what you need with \`read offset/limit\`):\n${rows.join('\n')}`
}

/** Render a directory scan as compact Markdown. */
export function formatDirectoryScan(scan) {
  if (scan.files.length === 0) return `**${scan.root}**\n\nNo indexable text files found.`
  const rows = scan.files.map(
    (f) => `- ${f.path}  (${fmtBytes(f.bytes)}) — inspect with context_index({"path":"${f.path}"})`,
  )
  return `**${scan.root}**  \n${scan.files.length} text files (largest first)${scan.truncated ? ', truncated' : ''}:\n${rows.join('\n')}`
}
