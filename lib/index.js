/**
 * dsh-recall-channel — a recall channel for compacted conversation history.
 *
 * The harness already keeps every original event in an append-only session log;
 * compaction only changes what the model can see. This plugin closes the loop:
 * it indexes which spans were shadowed, exposes `search_history` /
 * `recall_history`, and tells the model — once, right after a compaction — that
 * the material is still addressable.
 *
 * It deliberately does not: replace the compaction engine, modify history,
 * persist its own store, or add an embedding index. The log is the store.
 *
 * @module dsh-recall-channel
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createAnchor } from './anchor.js'
import { createTools } from './tools.js'

const name = 'recall-channel'

/**
 * Build-time constant injected by `build.mjs` (esbuild `define`). Loading
 * `lib/` directly — as the tests do — leaves it undefined, hence the guard.
 */
const VERSION = typeof __RC_VERSION__ === 'undefined' ? 'dev' : __RC_VERSION__

/** cordis enforces this list: reading an undeclared service throws. */
const inject = ['tools']

const Config = z.object({
  enabled: z.boolean(),
  searchLimit: z.number(),
  snippetChars: z.number(),
  scanLimit: z.number(),
  maxRecallTokens: z.number(),
  maxSessionRecallTokens: z.number(),
  includeReasoning: z.boolean(),
  hintOnCompaction: z.boolean(),
})

/** Fill defaults; schemastery may deliver `undefined` for absent numeric keys. */
function resolveConfig(raw) {
  const c = raw || {}
  const num = (value, fallback, min, max) => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.min(Math.max(n, min), max)
  }
  return {
    enabled: c.enabled !== false,
    searchLimit: num(c.searchLimit, 20, 1, 100),
    snippetChars: num(c.snippetChars, 240, 40, 2000),
    scanLimit: num(c.scanLimit, 50000, 1000, 500000),
    maxRecallTokens: num(c.maxRecallTokens, 16000, 256, 200000),
    maxSessionRecallTokens: num(c.maxSessionRecallTokens, 64000, 0, 2000000),
    includeReasoning: c.includeReasoning === true,
    hintOnCompaction: c.hintOnCompaction !== false,
  }
}

/** The one-shot notice that follows a compaction. */
function noticeText(entry) {
  const count = entry.shadowedSeqs.length
  return [
    `[recall-channel] History was just compacted: ${count} earlier message(s) (~${entry.shadowedTokenCount} tokens) left your visible context.`,
    `The originals are still in the durable session log under compaction id "${entry.id}".`,
    'If an answer depends on details from that span — exact paths, commands, error strings, numbers, identifiers, earlier decisions —',
    `call search_history to locate them, then recall_history with compactionId "${entry.id}" to read them verbatim.`,
    'Do not reconstruct those details from the summary.',
  ].join(' ')
}

function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const anchor = createAnchor(ctx)

  const tools = createTools(resolved, anchor)
  for (const tool of tools) ctx.tools.register(tool)
  console.log(`[recall-channel] v${VERSION} ready - ${tools.length} tool(s): ${tools.map((t) => t && t.name).join(', ')}${resolved.hintOnCompaction ? ' + post-compaction notice' : ''}`)

  if (resolved.hintOnCompaction) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (!decision || decision.kind === 'reject' || !agent) return decision
      // A compaction triggered during this step is picked up here: the pending
      // notice is set by the session/event feed while `next()` runs.
      const entry = anchor.takePending(agent.session)
      if (!entry) return decision
      const notice = createUserMessage({
        content: [{ type: 'text', text: noticeText(entry) }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-recall-channel',
          form: 'notice',
          summary: `compacted history ${entry.id}`,
        },
      })
      return { ...decision, messages: [...decision.messages, notice] }
    }, { prepend: true })
  }
}

export { Config, apply, inject, name }
