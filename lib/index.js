/**
 * dsh-recall-channel — a recall channel for compacted conversation history.
 *
 * The harness already keeps every original event in an append-only session log;
 * compaction only changes what the model can see. This plugin closes the loop:
 * it indexes which spans were shadowed, exposes `search_history` /
 * `recall_history`, and keeps one live notice telling the model that the
 * material is still addressable.
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
import { PLUGIN_ID, createNoticeTracker, noticeText, reminderText } from './notice.js'

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
  blockChars: z.number(),
  argChars: z.number(),
  searchTextChars: z.number(),
  maxRangeSeqs: z.number(),
  allowRegex: z.boolean(),
  regexMaxPatternChars: z.number(),
  regexInputChars: z.number(),
  regexBudgetMs: z.number(),
  includeReasoning: z.boolean(),
  hintOnCompaction: z.boolean(),
  notifyOnPrune: z.boolean(),
  noticeRefresh: z.boolean(),
  wrapRecalledText: z.boolean(),
})

/**
 * Fill defaults and clamp. `schemastery` may deliver `undefined` for absent
 * keys, and every bound here is also documented in the README — a silent clamp
 * that an operator cannot see is worse than no clamp at all.
 */
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
    scanLimit: num(c.scanLimit, 200000, 100, 2000000),
    maxRecallTokens: num(c.maxRecallTokens, 16000, 256, 200000),
    maxSessionRecallTokens: num(c.maxSessionRecallTokens, 64000, 0, 2000000),
    // Display caps. 0 = verbatim: the token budget, not a hidden per-block
    // shears, is what bounds a restore.
    blockChars: num(c.blockChars, 0, 0, 1000000),
    argChars: num(c.argChars, 0, 0, 1000000),
    // Search projections keep their own ceiling so one pathological event
    // cannot make every search expensive.
    searchTextChars: num(c.searchTextChars, 200000, 0, 5000000),
    maxRangeSeqs: num(c.maxRangeSeqs, 200000, 1, 2000000),
    allowRegex: c.allowRegex !== false,
    regexMaxPatternChars: num(c.regexMaxPatternChars, 200, 8, 2000),
    regexInputChars: num(c.regexInputChars, 20000, 1000, 5000000),
    regexBudgetMs: num(c.regexBudgetMs, 250, 10, 10000),
    includeReasoning: c.includeReasoning === true,
    hintOnCompaction: c.hintOnCompaction !== false,
    notifyOnPrune: c.notifyOnPrune !== false,
    noticeRefresh: c.noticeRefresh !== false,
    wrapRecalledText: c.wrapRecalledText !== false,
  }
}

function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const anchor = createAnchor(ctx)
  const notices = createNoticeTracker()

  const tools = createTools(resolved, anchor)
  for (const tool of tools) ctx.tools.register(tool)
  console.log(`[recall-channel] v${VERSION} ready - ${tools.length} tool(s): ${tools.map((t) => t && t.name).join(', ')}${resolved.hintOnCompaction ? ' + post-compaction notice' : ''}`)

  // Recognise our own notices. Their seq is what lets us tell that the standing
  // guidance has since been compacted away.
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const source = event.data && event.data.source
    if (!source || source.kind !== 'plugin' || source.plugin !== PLUGIN_ID) return
    notices.recordNotice(session, event.seq)
  })

  if (resolved.hintOnCompaction) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (!decision || decision.kind === 'reject' || !agent) return decision
      const session = agent.session

      let text = null
      let summary = 'history was compacted'
      // A compaction triggered during this step is picked up here: the pending
      // notices are queued by the session/event feed while `next()` runs.
      const pending = anchor.takePending(session).filter((entry) => entry.kind !== 'prune' || resolved.notifyOnPrune)
      if (pending.length > 0) {
        text = noticeText(pending)
      } else if (resolved.noticeRefresh) {
        // Notices are ordinary appended messages, so the next compaction eats
        // them. When the standing one has been shadowed, post one terse
        // replacement — at most one per shadowing event.
        const latestShadowSeq = anchor.latestShadowSeq(session)
        const shadowedSeqSet = anchor.shadowedSeqSet(session)
        if (notices.shouldRefresh(session, { shadowedSeqSet, latestShadowSeq })) {
          notices.markRefreshed(session, latestShadowSeq)
          text = reminderText(anchor.list(session).slice(0, 3))
          summary = 'recall reminder'
        }
      }
      if (!text) return decision

      const notice = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary },
      })
      return { ...decision, messages: [...decision.messages, notice] }
    }, { prepend: true })
  }
}

export { Config, apply, inject, name }
