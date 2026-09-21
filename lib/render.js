/**
 * Event → text projection.
 *
 * Every rendered block carries its role, because a bare match cannot be told
 * apart otherwise: a matching line may be the user talking, the model thinking,
 * a tool call, or a tool result. Borrowed from VCC's adaptive view, which pairs
 * every match with a block pointer and a block role.
 *
 * @module dsh-recall-channel/render
 */

/** Per-block clip so one giant tool result cannot dominate a render. */
const BLOCK_CHARS = 6000
/** Tool-call arguments are raw JSON; keep them recognisable, not exhaustive. */
const ARGS_CHARS = 1200

function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`
}

/**
 * Render model-facing content blocks to plain text, tagged by kind.
 * @param content - content blocks from a message or nested tool result.
 * @param opts - `includeReasoning` keeps `reasoning` blocks.
 * @returns newline-joined text.
 */
export function blocksToText(content, opts = {}) {
  const out = []
  for (const block of content ?? []) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (block.text) out.push(clip(block.text, BLOCK_CHARS))
        break
      case 'reasoning':
        if (opts.includeReasoning === true && block.text) out.push(`[thinking]\n${clip(block.text, BLOCK_CHARS)}`)
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
        out.push(`[tool_call ${block.name}] ${clip(block.arguments ?? '', ARGS_CHARS)}`)
        break
      case 'tool-result': {
        const nested = blocksToText(block.content, opts)
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
 * @returns rendered text, or `null` for events with no model-visible content.
 */
export function renderEvent(event, opts = {}) {
  const data = (event && event.data) || {}
  switch (event && event.type) {
    case 'user/message':
      return `## user\n${blocksToText(data.content, opts)}`
    case 'assistant/message':
      return `## assistant\n${blocksToText(data.message && data.message.content, opts)}`
    case 'system/message':
      return `## system\n${blocksToText(data.message && data.message.content, opts)}`
    case 'tool/call':
      return `## tool_call ${data.name}\n${clip(data.arguments ?? '', ARGS_CHARS)}`
    case 'tool/result': {
      const blocks = (data.message && data.message.content) || []
      const first = blocks[0]
      const inner = first && first.type === 'tool-result'
        ? blocksToText(first.content, opts)
        : blocksToText(blocks, opts)
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
 * Cheap text form used for matching and snippets: the rendered block without
 * its `## role` header, so a snippet can re-attach the role itself.
 * @param event - a session event.
 * @param opts - render options.
 * @returns searchable text, or `''`.
 */
export function eventPlainText(event, opts = {}) {
  if (!event || SKIPPED.has(event.type)) return ''
  const rendered = renderEvent(event, opts)
  if (!rendered) return ''
  const newline = rendered.indexOf('\n')
  return newline < 0 ? '' : rendered.slice(newline + 1)
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
  const half = Math.max(20, Math.floor(width / 2))
  const start = Math.max(0, index - half)
  const end = Math.min(text.length, index + half)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return head + text.slice(start, end).replace(/\s+/g, ' ').trim() + tail
}
