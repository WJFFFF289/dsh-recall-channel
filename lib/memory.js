/**
 * Workspace shared memory: an append-only memory file the model can write to.
 *
 * The session log is the archive (verbatim, addressed by seq), the context
 * window is scratch paper (compacted away), and this file is the notebook:
 * it lives OUTSIDE the context window, so compaction can never touch it.
 * Every session in the same workspace (cwd) reads and writes the same file.
 *
 * Anti-pollution rules (learned from Letta/MemGPT's self-editing pitfalls):
 * 1. Append-only. A wrong line is never edited — it is corrected by a newer
 *    line, or removed via workspace_forget. The mistake stays visible.
 * 2. Every line carries its source sessionId, so a bad entry can be traced
 *    back to the session that wrote it.
 * 3. Bounded. Past `memoryFileMaxChars` the oldest half of the entries rolls
 *    into `workspace-memory.archive.md` (still on disk, just not injected).
 * 4. One line per entry. Newlines inside content are collapsed so the file
 *    stays line-addressable forever.
 *
 * @module dsh-recall-channel/memory
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const MEMORY_DIR = '.workbuddy'
const MEMORY_FILE = 'workspace-memory.md'
const ARCHIVE_FILE = 'workspace-memory.archive.md'
const HEADER = '# 工作区记忆（dsh-recall-channel · 跨会话共享）\n\n'
const ENTRY_PREFIX = '- ['
const MAX_ENTRY_CHARS = 500

/** Filesystem locations for one workspace. */
export function memoryPaths(cwd) {
  const dir = `${cwd}/${MEMORY_DIR}`
  return { dir, main: `${dir}/${MEMORY_FILE}`, archive: `${dir}/${ARCHIVE_FILE}` }
}

/** `2026-09-29 16:30` in local time, compact and sortable. */
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Short session label: `session-abcdef` → `abcdef`, full id otherwise kept. */
function shortSessionId(sessionId) {
  const s = String(sessionId || 'unknown')
  return s.startsWith('session-') ? s.slice(8, 14) : s.slice(0, 14)
}

/**
 * Parse the memory file into header lines and entry lines.
 * Entries are lines starting with `- [`; everything else is preserved
 * verbatim so hand-written notes survive rewrites.
 */
function parseMemoryFile(text) {
  const lines = text.split('\n')
  const entries = []
  const passthrough = []
  lines.forEach((line, index) => {
    if (line.startsWith(ENTRY_PREFIX)) entries.push({ index, line })
    else passthrough.push({ index, line })
  })
  return { lines, entries, passthrough }
}

/** Serialise writes per workspace so concurrent sessions cannot interleave. */
const writeQueues = new Map()
function enqueue(cwd, task) {
  const prev = writeQueues.get(cwd) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeQueues.set(cwd, next.catch(() => {}))
  return next
}

/**
 * Append one entry to the workspace memory file.
 *
 * @param opts.cwd - workspace directory.
 * @param opts.sessionId - the writing session (stamped on the line).
 * @param opts.content - memory text; collapsed to one line, capped at 500 chars.
 * @param opts.maxChars - file budget; overflow rolls the oldest half to archive.
 * @returns receipt with the written line and file stats.
 */
export async function appendMemory({ cwd, sessionId, content, maxChars }) {
  return enqueue(cwd, async () => {
    const { readFile, writeFile, mkdir, appendFile } = await import('node:fs/promises')
    const paths = memoryPaths(cwd)
    const oneLine = String(content ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').trim()
    if (!oneLine) throw new Error('workspace_remember: content must not be empty')
    const clipped = oneLine.length > MAX_ENTRY_CHARS ? `${oneLine.slice(0, MAX_ENTRY_CHARS)}…` : oneLine
    const line = `${ENTRY_PREFIX}${formatTimestamp(new Date())} | ${shortSessionId(sessionId)}] ${clipped}`

    await mkdir(paths.dir, { recursive: true })
    let text = ''
    try {
      text = await readFile(paths.main, 'utf8')
    } catch { /* first entry creates the file */ }
    if (!text) text = HEADER
    if (!text.endsWith('\n')) text += '\n'
    text += `${line}\n`

    const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 8000
    let archived = null
    if (text.length > budget) {
      const { lines, entries, passthrough } = parseMemoryFile(text)
      const keepFrom = Math.ceil(entries.length / 2)
      const moved = entries.slice(0, keepFrom)
      const kept = entries.slice(keepFrom)
      if (moved.length > 0) {
        await appendFile(paths.archive, `${moved.map((e) => e.line).join('\n')}\n`, 'utf8').catch(() => {})
        archived = { moved: moved.length, to: paths.archive }
      }
      const keptIndexes = new Set(kept.map((e) => e.index))
      const rebuilt = []
      for (const { index, line: l } of passthrough) {
        if (index < (entries[0]?.index ?? Infinity)) rebuilt.push(l)
      }
      text = `${rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n\n${keptIndexes.size ? lines.filter((_, i) => keptIndexes.has(i)).join('\n') : ''}\n`
    }

    await writeFile(paths.main, text, 'utf8')
    const { entries } = parseMemoryFile(text)
    return {
      line,
      totalEntries: entries.length,
      totalChars: text.length,
      path: paths.main,
      archived,
    }
  })
}

/**
 * Read the whole memory file.
 * @param opts.cwd - workspace directory.
 * @returns `{ entries: [{ n, line }], text, totalChars, path }` — `n` is the
 *   1-based entry number used by workspace_forget.
 */
export async function readMemory({ cwd }) {
  const { readFile } = await import('node:fs/promises')
  const paths = memoryPaths(cwd)
  let text = ''
  try {
    text = await readFile(paths.main, 'utf8')
  } catch {
    return { entries: [], text: '', totalChars: 0, path: paths.main }
  }
  const { entries } = parseMemoryFile(text)
  return {
    entries: entries.map((e, i) => ({ n: i + 1, line: e.line })),
    text,
    totalChars: text.length,
    path: paths.main,
  }
}

/**
 * Delete entries by 1-based entry number (as listed by workspace_memory /
 * workspace_forget query results).
 */
export async function deleteMemoryEntries({ cwd, numbers }) {
  return enqueue(cwd, async () => {
    const { readFile, writeFile } = await import('node:fs/promises')
    const paths = memoryPaths(cwd)
    let text = ''
    try {
      text = await readFile(paths.main, 'utf8')
    } catch {
      throw new Error('workspace_forget: no memory file in this workspace')
    }
    const { lines, entries } = parseMemoryFile(text)
    const wanted = new Set(numbers)
    const toDelete = new Set()
    const removed = []
    entries.forEach((e, i) => {
      if (wanted.has(i + 1)) {
        toDelete.add(e.index)
        removed.push(e.line)
      }
    })
    if (removed.length === 0) {
      throw new Error(`workspace_forget: no entries numbered ${[...wanted].join(', ')} (file has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`)
    }
    const kept = lines.filter((_, i) => !toDelete.has(i))
    const rebuilt = kept.join('\n').replace(/\n{3,}/g, '\n\n')
    await writeFile(paths.main, rebuilt.endsWith('\n') ? rebuilt : `${rebuilt}\n`, 'utf8')
    return { removed, remaining: entries.length - removed.length }
  })
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

/**
 * Build the three memory tools. They need no sessionQuery — only the caller's
 * cwd — so they register even on DSH builds without the session-query service.
 *
 * @param config - resolved plugin config.
 * @param ctx - plugin context (for the optional confirm-write question).
 */
export function createMemoryTools(config, ctx) {
  const remember = defineTool({
    name: 'workspace_remember',
    description: [
      'Write one line to this workspace\'s shared memory file — visible to EVERY session in this',
      'workspace, including future ones. Use it for conclusions, decisions, gotchas and preferences',
      'that later sessions must not lose: root causes, "we chose X over Y", "never do Z here".',
      'Do NOT use it for secrets, credentials, or transient chatter. Lines are append-only,',
      'timestamped, and stamped with your session id; a wrong line is corrected by a newer line',
      'or removed with workspace_forget. The file is capped and the oldest lines roll into an archive.',
    ].join(' '),
    parameters: {
      content: { type: 'string', required: true, description: 'One memory line (newlines are collapsed; capped at 500 chars).' },
      tags: { type: 'string', description: 'Optional short category, e.g. "decision", "gotcha", "preference".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'string', required: true },
          totalEntries: { type: 'integer', required: true },
          totalChars: { type: 'integer', required: true },
          archived: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [`[workspace_remember] written (${value.totalEntries} entries, ${value.totalChars} chars):`, value.line]
        if (value.archived) lines.push('The file hit its cap; the oldest half rolled into workspace-memory.archive.md.')
        if (!value.confirmed) lines.push('(written without user confirmation)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      const cwd = session?.header?.cwd
      if (!cwd) throw new Error('workspace_remember: this session has no working directory')
      const content = String(args.content ?? '').trim()
      if (!content) throw new Error('workspace_remember: content must not be empty')
      const tagged = args.tags ? `[${String(args.tags).slice(0, 40)}] ${content}` : content

      let confirmed = true
      if (config.memoryConfirmWrite === true) {
        const userQuestions = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
        if (userQuestions) {
          try {
            const answer = await userQuestions.ask({
              questions: [{
                id: 'memory-confirm',
                header: '写入工作区记忆？',
                question: `要把这条写进工作区共享记忆吗（所有会话可见）：\n${tagged.slice(0, 300)}`,
                options: [
                  { label: '写入', description: '追加到 workspace-memory.md' },
                  { label: '不写入', description: '放弃这条记忆' },
                ],
              }],
              ...(exec?.agent ? { agent: exec.agent } : {}),
              signal: exec?.signal,
            })
            const picked = answer?.answers?.[0]?.selected?.[0] ?? ''
            if (!picked.startsWith('写入')) {
              return { line: '', totalEntries: -1, totalChars: -1, archived: false, confirmed: false }
            }
          } catch {
            // Cancelled/aborted/no provider: treat as refusal, never force-write.
            return { line: '', totalEntries: -1, totalChars: -1, archived: false, confirmed: false }
          }
        }
      }

      const receipt = await appendMemory({
        cwd,
        sessionId: session?.id ?? 'unknown',
        content: tagged,
        maxChars: config.memoryFileMaxChars,
      })
      return {
        line: receipt.line,
        totalEntries: receipt.totalEntries,
        totalChars: receipt.totalChars,
        archived: receipt.archived !== null,
        confirmed,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Write workspace memory', kind: 'edit', rawInput: String(args.content ?? '').slice(0, 80) }),
  })

  const memory = defineTool({
    name: 'workspace_memory',
    description: [
      'Read this workspace\'s shared memory file: conclusions and decisions written by earlier',
      'sessions in this workspace. Entry numbers are stable within a call — workspace_forget',
      'uses them to remove lines. This file is also injected when a session chooses to resume',
      'the workspace, so what you write here shapes every future session.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', required: true }, line: { type: 'string', required: true } } } },
          totalChars: { type: 'integer', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        if (value.entries.length === 0) return [{ type: 'text', text: `[workspace_memory] no memory yet (${value.path}).` }]
        const lines = [`[workspace_memory] ${value.entries.length} entr${value.entries.length === 1 ? 'y' : 'ies'} (${value.totalChars} chars, ${value.path}):`]
        for (const e of value.entries) lines.push(`${e.n}. ${e.line}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd
      if (!cwd) throw new Error('workspace_memory: this session has no working directory')
      return readMemory({ cwd })
    },
    presentCall: () => ({ card: 'generic', title: 'Read workspace memory', kind: 'read' }),
  })

  const forget = defineTool({
    name: 'workspace_forget',
    description: [
      'Remove lines from this workspace\'s shared memory file. Two-step by design:',
      'call with `query` to list matching entries with their numbers, then call with',
      '`lines` to delete specific numbers. Deleting is the ONLY way to edit memory —',
      'a wrong fact should otherwise be corrected by appending a newer line.',
    ].join(' '),
    parameters: {
      query: { type: 'string', description: 'Case-insensitive substring to find candidate entries (no deletion).' },
      lines: { type: 'array', items: { type: 'integer' }, description: 'Entry numbers to delete (from a query result or workspace_memory).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', required: true }, line: { type: 'string', required: true } } } },
          removed: { type: 'array', items: { type: 'string' } },
          remaining: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.matches) {
          if (value.matches.length === 0) lines.push('[workspace_forget] no matching entries.')
          else {
            lines.push(`[workspace_forget] ${value.matches.length} match(es) — call again with lines: [n, ...] to delete:`)
            for (const m of value.matches) lines.push(`${m.n}. ${m.line}`)
          }
        } else {
          lines.push(`[workspace_forget] removed ${value.removed.length} entr${value.removed.length === 1 ? 'y' : 'ies'} (${value.remaining} left):`)
          for (const r of value.removed) lines.push(`- ${r}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd
      if (!cwd) throw new Error('workspace_forget: this session has no working directory')
      if (Array.isArray(args.lines) && args.lines.length > 0) {
        const numbers = [...new Set(args.lines.filter((n) => Number.isInteger(n) && n > 0))]
        if (numbers.length === 0) throw new Error('workspace_forget: lines must be positive integers')
        if (numbers.length > 100) throw new Error('workspace_forget: too many lines at once (max 100)')
        const result = await deleteMemoryEntries({ cwd, numbers })
        return { removed: result.removed, remaining: result.remaining }
      }
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('workspace_forget requires a query (to list candidates) or lines (to delete)')
      const { entries } = await readMemory({ cwd })
      const needle = query.toLowerCase()
      const matches = entries.filter((e) => e.line.toLowerCase().includes(needle)).slice(0, 50)
      return { matches }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Forget workspace memory', kind: 'delete', rawInput: args.query ?? (args.lines ?? []).join(',') }),
  })

  return [remember, memory, forget]
}
