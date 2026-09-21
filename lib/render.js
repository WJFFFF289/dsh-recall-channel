/**
 * Event → text projection.
 *
 * Every rendered block carries its role, because a bare match cannot be told
 * apart otherwise: a matching line may be the user talking, the model thinking,
 * a tool call, or a tool result. Borrowed from VCC's adaptive view, which pairs
 * every match with a block pointer and a block role.
 *
 * There are two projections, and keeping them apart matters:
 *
 * - `renderEvent` is the *display* projection: it optionally bounds each block
 *   so one giant tool result cannot dominate a restore. Any bytes it drops are
 *   counted into `clipStats`, so the caller can report them honestly.
 * - `eventSearchText` is the *search* projection: it never applies the display
 *   cap, because clipping here used to make search miss text that is really in
 *   the log — a false "no matches" for a needle sitting past the cap. It has
 *   its own, much larger ceiling, and counts the events it hits.
 *
 * @module dsh-recall-channel/render
 */

import { clipAtCodePoint, windowAround } from './metrics.js'

/** Tool-call arguments are raw JSON; `argChars` caps them (0 = verbatim). */
const DEFAULT_ARG_CHARS = 0

/**
 * Clip one block, recording what was dropped.
 * @param text - source text.
 * @param max - cap in UTF-16 units; `<= 0` disables the cap.
 * @param stats - optional `{ blockChars, argChars, blocks, args }` accumulator.
 * @param kind - `'args'` routes the count into `argChars`/`args`.
 * @returns clipped text.
 */
function clip(text, max, stats, kind) {
  if (typeof text !== 'string') return ''
  const limit = Number.isFinite(max) ? max : 0
  if (limit <= 0) return text
  if (text.length <= limit) return text
  const { text: kept, dropped } = clipAtCodePoint(text, limit)
  if (stats) {
    if (kind === 'args') {
      stats.argChars += dropped
      stats.args += 1
    } else {
      stats.blockChars += dropped
      stats.blocks += 1
    }
  }
  return `${kept}…[+${dropped} chars]`
}

/** @returns a fresh clip accumulator. */
export function createClipStats() {
  return { blockChars: 0, argChars: 0, blocks: 0, args: 0 }
}

/**
 * Render model-facing content blocks to plain text, tagged by kind.
 * @param content - content blocks from a message or nested tool result.
 * @param opts - `includeReasoning` keeps `reasoning` blocks; `blockChars` caps each block.
 * @param stats - optional clip accumulator for honest reporting.
 * @returns newline-joined text.
 */
export function blocksToText(content, opts = {}, stats = null) {
  const out = []
  for (const block of content ?? []) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (block.text) out.push(clip(block.text, opts.blockChars, stats, 'text'))
        break
      case 'reasoning':
        if (opts.includeReasoning === true && block.text) out.push(`[thinking]\n${clip(block.text, opts.blockChars, stats, 'text')}`)
        break
      case 'image':
        out.push(block.offloaded === true ? '[image: offloaded to a placeholder]' : '[image]')
        break
      case 'file': {
        const fileName = block.attachment && block.attachment.name ? block.attachment.name : ''
        out.push(fileName ? `[file ${fileName}]` : '[file]')
        break
      }
      case 'tool-call':
        out.push(`[tool_call ${block.name}] ${clip(block.arguments ?? '', opts.argChars ?? DEFAULT_ARG_CHARS, stats, 'args')}`)
        break
      case 'tool-result': {
        const nested = blocksToText(block.content, opts, stats)
        out.push(`[tool_result${block.isError === true ? ' error' : ''}]${nested ? `\n${nested}` : ''}`)
        break
      }
      default:
        out.push(`[${String(block.type)}]`)
    }
  }
  return out.filter(Boolean).join('\n')
}

/**
 * Render one session event as a role-tagged block.
 * @param event - a session event (`{ seq, type, data }`).
 * @param opts - render options.
 * @param stats - optional clip accumulator.
 * @returns rendered text, or `null` for events with no model-visible content.
 */
export function renderEvent(event, opts = {}, stats = null) {
  const data = (event && event.data) || {}
  switch (event && event.type) {
    case 'user/message':
      return `## user\n${blocksToText(data.content, opts, stats)}`
    case 'assistant/message':
      return `## assistant\n${blocksToText(data.message && data.message.content, opts, stats)}`
    case 'system/message':
      return `## system\n${blocksToText(data.message && data.message.content, opts, stats)}`
    case 'tool/call':
      return `## tool_call ${data.name}\n${clip(data.arguments ?? '', opts.argChars ?? DEFAULT_ARG_CHARS, stats, 'args')}`
    case 'tool/result': {
      const blocks = (data.message && data.message.content) || []
      const first = blocks[0]
      const inner = first && first.type === 'tool-result'
        ? blocksToText(first.content, opts, stats)
        : blocksToText(blocks, opts, stats)
      const flag = (first && first.isError === true) || data.error ? ' (error)' : ''
      return `## tool_result${flag}\n${inner}`
    }
    default:
      return null
  }
}

/** Events that never carry model-visible conversation text. */
const SKIPPED = new Set([
  'assistant/attempt', 'assistant/stream', 'request/header', 'request/context',
  'step/start', 'step/end', 'turn/start', 'turn/end', 'llm/retry', 'llm/retry-started',
])

/**
 * Searchable text for one event: the rendered block without its `## role`
 * header, and *without* the display cap — the only ceiling is
 * `opts.searchTextChars`, which exists to bound the cost of one pathological
 * event rather than to shape output.
 *
 * Callers are expected to pass an opts object whose `blockChars`/`argChars` are
 * already 0 (built once per search, not per event): this runs on every event in
 * the log, so it must not allocate.
 *
 * @param event - a session event.
 * @param opts - `searchTextChars` caps one event's searchable text (`<= 0` = none).
 * @param stats - optional `{ largeEvents, cappedChars }` accumulator.
 * @returns searchable text, or `''`.
 */
export function eventSearchText(event, opts = {}, stats = null) {
  if (!event || SKIPPED.has(event.type)) return ''
  const rendered = renderEvent(event, opts, null)
  if (!rendered) return ''
  const newline = rendered.indexOf('\n')
  const body = newline < 0 ? '' : rendered.slice(newline + 1)
  const cap = Number.isFinite(opts.searchTextChars) ? opts.searchTextChars : 0
  if (cap > 0 && body.length > cap) {
    if (stats) {
      stats.largeEvents += 1
      stats.cappedChars += body.length - cap
    }
    return clipAtCodePoint(body, cap).text
  }
  return body
}

/** @returns a fresh search-projection accumulator. */
export function createSearchStats() {
  return { largeEvents: 0, cappedChars: 0 }
}

/**
 * Role label for one event, used in search hits.
 * @param event - a session event.
 * @returns short role string.
 */
export function eventRole(event) {
  switch (event && event.type) {
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'system/message': return 'system'
    case 'tool/call': return 'tool_call'
    case 'tool/result': return 'tool_result'
    default: return String((event && event.type) || 'unknown')
  }
}

/**
 * Window of text around one match, with ellipses showing what was cut.
 * @param text - full searchable text.
 * @param index - match offset.
 * @param width - approximate snippet width in characters.
 * @returns snippet string.
 */
export function snippetAround(text, index, width) {
  return windowAround(text, index, width)
}
