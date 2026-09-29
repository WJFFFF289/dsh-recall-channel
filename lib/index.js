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
import { createWorkspaceTools } from './workspace.js'
import { createMemoryTools } from './memory.js'
import { registerOnboard } from './onboard.js'
import { PRODUCER_KIND, createNoticeTracker, isOwnSource, noticeText, reminderText } from './notice.js'

const name = 'recall-channel'

/**
 * Build-time constant injected by `build.mjs` (esbuild `define`). Loading
 * `lib/` directly — as the tests do — leaves it undefined, hence the guard.
 */
const VERSION = typeof __RC_VERSION__ === 'undefined' ? 'dev' : __RC_VERSION__

/**
 * cordis enforces this list: reading an undeclared service throws.
 *
 * `sessionQuery` is deliberately NOT declared here. It is accessed via
 * `ctx.get('sessionQuery')` (returns `undefined` when absent), so the plugin
 * degrades gracefully on DSH builds without the session-query service — the
 * two single-session tools keep working, the three workspace tools skip.
 * This is the same pattern the codebase uses for `agents` and `sandboxPolicy`.
 */
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
  workspaceSummaryChars: z.number(),
  onboardMode: z.string(),
  onboardMaxSessions: z.number(),
  onboardSummaryChars: z.number(),
  workspaceSearch: z.boolean(),
  searchMaxSessions: z.number(),
  memoryEnabled: z.boolean(),
  memoryFileMaxChars: z.number(),
  memoryConfirmWrite: z.boolean(),
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
    // Cap one compaction summary's text in workspace_session_summary output.
    // 0 = verbatim (not recommended: 20 summaries × 3KB each = 60KB into the
    // model's context window).
    workspaceSummaryChars: num(c.workspaceSummaryChars, 500, 0, 50000),
    // Onboarding (new-session resume offer). 'ask' pins a userQuestions card,
    // 'notice' injects a plain hint, 'off' disables. Anything else → 'ask'.
    onboardMode: ['ask', 'notice', 'off'].includes(c.onboardMode) ? c.onboardMode : 'ask',
    onboardMaxSessions: num(c.onboardMaxSessions, 5, 1, 20),
    onboardSummaryChars: num(c.onboardSummaryChars, 500, 0, 5000),
    // Cross-session search tool.
    workspaceSearch: c.workspaceSearch !== false,
    searchMaxSessions: num(c.searchMaxSessions, 20, 1, 100),
    // Writable shared memory file (<cwd>/.workbuddy/workspace-memory.md).
    memoryEnabled: c.memoryEnabled !== false,
    memoryFileMaxChars: num(c.memoryFileMaxChars, 8000, 1000, 100000),
    memoryConfirmWrite: c.memoryConfirmWrite === true,
  }
}

function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const anchor = createAnchor(ctx)
  const notices = createNoticeTracker()

  const tools = createTools(resolved, anchor)
  for (const tool of tools) ctx.tools.register(tool)

  // Memory tools need only the caller's cwd — they register even on hosts
  // without sessionQuery, unlike the workspace tools below.
  if (resolved.memoryEnabled) {
    for (const tool of createMemoryTools(resolved, ctx)) ctx.tools.register(tool)
  }

  // Workspace onboarding (resume offer) fires on the first pre-step of a new
  // session. It reads sessionQuery lazily via ctx.get(), so it degrades to a
  // memory-only resume on hosts without the service.
  const onboarded = registerOnboard(resolved, ctx)

  // Workspace tools (cross-session recall) — requires the sessionQuery
  // service (DSH 0.1.7+). Registration is deferred: cordis loads services
  // asynchronously, and sessionQuery may not be available yet when apply()
  // runs. ctx.inject() fires the callback once the service is provided,
  // so workspace tools appear as soon as the backend is ready rather than
  // being silently skipped on profiles where the load order differs.
  let wsToolCount = 0
  const registerWorkspaceTools = (targetCtx) => {
    let wsTools = createWorkspaceTools(resolved, targetCtx)
    if (!resolved.workspaceSearch) wsTools = wsTools.filter((t) => t && t.name !== 'workspace_search')
    for (const tool of wsTools) targetCtx.tools.register(tool)
    wsToolCount = wsTools.length
    console.log(`[recall-channel] sessionQuery ready — ${wsToolCount} workspace tool(s) registered: ${wsTools.map((t) => t && t.name).join(', ')}`)
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionQuery'], (childCtx) => registerWorkspaceTools(childCtx))
  } else {
    // Fallback for minimal hosts without ctx.inject: try ctx.get() directly.
    const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (sessionQuery) registerWorkspaceTools(ctx)
  }

  console.log(`[recall-channel] v${VERSION} ready - ${tools.length} tool(s): ${tools.map((t) => t && t.name).join(', ')}${resolved.hintOnCompaction ? ' + post-compaction notice' : ''}${resolved.memoryEnabled ? ' + memory tools (3)' : ''}${onboarded ? ` + onboard(${resolved.onboardMode})` : ''} (workspace tools register when sessionQuery is ready)`)

  // Recognise our own notices. Their seq is what lets us tell that the standing
  // guidance has since been compacted away.
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    if (!isOwnSource(event.data && event.data.source)) return
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
        // Format V4 refuses the retired `{ kind: 'plugin', plugin }` wrapper, so the
        // producer names itself instead. Do not "simplify" this back — that exact
        // shape is what a V4 session rejects at write time.
        source: { kind: PRODUCER_KIND, form: 'notice', summary },
      })
      return { ...decision, messages: [...decision.messages, notice] }
    }, { prepend: true })
  }
}

export { Config, apply, inject, name }
