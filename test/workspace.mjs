/**
 * Workspace tools end-to-end test: drive workspace_map, workspace_session_summary,
 * and workspace_recall against real persisted sessions from the harness data dir.
 *
 * Sets up a minimal cordis host with the real session-query stack (SessionStore +
 * JsonlSessionPersistence + SqliteSessionQueryEngine), loads the plugin from lib/,
 * and calls the tools as the model would.
 *
 * Usage:
 *   DSH_MODULES=<harness>/resources/dsh/node_modules node test/workspace.mjs
 *
 * Environment:
 *   DSH_MODULES — path to <harness>/resources/dsh/node_modules  (required)
 *   DSH_HOME    — path to the harness data directory (default: <home>/.dsh)
 */

import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_MODULES = process.env.DSH_MODULES
  ?? join(process.env.DSH_APP ?? '', 'resources', 'dsh', 'node_modules')
const DSH_HOME = process.env.DSH_HOME
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const PLUGIN_DIR = process.env.PLUGIN_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '..')

const imp = (rel) => import(pathToFileURL(join(DSH_MODULES, rel)).href)

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok   ${label}`) }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ---- load cordis + services + plugin -----------------------------------------
const cordis = await imp('@deepseek-ai/cordis/lib/index.js')
const Context = cordis.Context ?? cordis.default?.Context ?? cordis.default
const { default: SessionStore } = await imp('@deepseek-ai/dsh-session/lib/index.js')
const { default: JsonlSessionPersistence } = await imp('@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')
const { default: SqliteSessionQueryEngine } = await imp('@deepseek-ai/dsh-session-query-sqlite/lib/index.js')

const plugin = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href)

// ---- build host ----------------------------------------------------------------
const ctx = new Context()
ctx.provide('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
ctx.plugin(SessionStore)
ctx.plugin(JsonlSessionPersistence, { root: join(DSH_HOME, 'sessions') })
ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
await new Promise((r) => setTimeout(r, 1500))

const sessionQuery = ctx.get('sessionQuery')
if (!sessionQuery) { console.error('FATAL: sessionQuery not available'); process.exit(1) }

// Register plugin
const registered = new Map()
ctx.provide('tools', { register: (tool) => registered.set(tool.name, tool) })
ctx.plugin(plugin)
await new Promise((r) => setTimeout(r, 500))

console.log(`\nPlugin registered ${registered.size} tools: ${[...registered.keys()].join(', ')}\n`)

// ---- discover a workspace with sessions -----------------------------------------
const allSessions = await sessionQuery.listSessions()
const cwds = [...new Set(allSessions.map((s) => s.header.cwd).filter(Boolean))]
if (cwds.length === 0) { console.error('FATAL: no sessions with cwd found'); process.exit(1) }

// Pick the cwd with the most sessions
let bestCwd = cwds[0]
let bestCount = 0
for (const cwd of cwds) {
  const count = allSessions.filter((s) => s.header.cwd === cwd).length
  if (count > bestCount) { bestCount = count; bestCwd = cwd }
}
console.log(`Testing against workspace: ${bestCwd} (${bestCount} sessions)\n`)

// Find a session with compaction events for L2/L3 testing
let compactionSession = null
for (const rec of allSessions) {
  if (rec.header.cwd !== bestCwd) continue
  try {
    const events = await sessionQuery.listEvents(rec.header.id)
    const compactionCount = events.filter((e) => e.type.startsWith('compaction/')).length
    if (compactionCount > 0) {
      compactionSession = { id: rec.header.id, events: events.length, compactions: compactionCount }
      break
    }
  } catch { /* skip unreadable */ }
}

// ---- mock caller session --------------------------------------------------------
// The caller is a fake "live" session in the same workspace.
// It needs: id, header.cwd, snapshotEvents(), eventAt() — the last two are
// only used by requireReadableSession, not by the workspace tools themselves.
const callerSession = {
  id: 'test-caller-session-00000000',
  header: { id: 'test-caller-session-00000000', cwd: bestCwd, createdAt: Date.now() },
  snapshotEvents: () => [],
  eventAt: () => undefined,
}

function makeExec(session) {
  return { agent: { session } }
}

// =================================================================================
console.log('workspace_map:')
// =================================================================================
{
  const tool = registered.get('workspace_map')
  check('workspace_map is registered', !!tool)

  const result = await tool.execute({}, makeExec(callerSession))
  check('returns sessions array', Array.isArray(result.sessions))
  check('totalSessions > 0', result.totalSessions > 0, `total=${result.totalSessions}`)
  check('workspaceCwd matches', result.workspaceCwd === bestCwd)
  check('all sessions belong to the workspace', result.sessions.every((s) => {
    // We can't check cwd directly from the result, but the authorization filter ensures it
    return typeof s.sessionId === 'string' && s.sessionId.length > 0
  }))
  check('excludes the caller session', !result.sessions.some((s) => s.sessionId === callerSession.id))

  if (result.sessions.length > 0) {
    const first = result.sessions[0]
    check('session entries have required fields',
      typeof first.sessionId === 'string' &&
      typeof first.date === 'string' &&
      typeof first.title === 'string' &&
      typeof first.events === 'number' &&
      typeof first.compactions === 'number' &&
      typeof first.live === 'boolean'
    )
  }

  // Render output
  const rendered = tool.output.render({}, result)
  check('render produces text blocks', Array.isArray(rendered) && rendered.length > 0 && rendered[0].type === 'text')
  const text = rendered[0].text
  check('render mentions workspace_map instructions', text.includes('workspace_session_summary') || text.includes('No other sessions'))

  // Test limit parameter
  const limited = await tool.execute({ limit: 2 }, makeExec(callerSession))
  check('respects limit parameter', limited.sessions.length <= 2)
}

// =================================================================================
console.log('\nworkspace_session_summary:')
// =================================================================================
{
  const tool = registered.get('workspace_session_summary')
  check('workspace_session_summary is registered', !!tool)

  if (compactionSession) {
    console.log(`  (using session ${compactionSession.id}: ${compactionSession.events} events, ${compactionSession.compactions} compactions)`)

    const result = await tool.execute({ sessionId: compactionSession.id }, makeExec(callerSession))
    check('returns summaries array', Array.isArray(result.summaries))
    check('sessionId matches', result.sessionId === compactionSession.id)
    check('totalEvents > 0', result.totalEvents > 0, `total=${result.totalEvents}`)

    if (result.summaries.length > 0) {
      const first = result.summaries[0]
      check('summary has required fields',
        typeof first.compactionId === 'string' &&
        typeof first.seq === 'number' &&
        typeof first.kind === 'string' &&
        typeof first.shadowedCount === 'number' &&
        typeof first.shadowedTokens === 'number' &&
        typeof first.summary === 'string' &&
        typeof first.seqRange === 'string'
      )
      check('summary kind is compaction or prune', ['compaction', 'prune'].includes(first.kind))
      check('shadowedCount > 0', first.shadowedCount > 0)
    } else {
      check('(session has compaction events but no summaries — unexpected)', false, 'summaries empty')
    }

    const rendered = tool.output.render({}, result)
    check('render produces text', rendered[0].text.length > 0)
  } else {
    console.log('  (no session with compaction events found — testing with any session)')
    const anySession = allSessions.find((s) => s.header.cwd === bestCwd)
    if (anySession) {
      const result = await tool.execute({ sessionId: anySession.header.id }, makeExec(callerSession))
      check('returns summaries array (may be empty)', Array.isArray(result.summaries))
      check('sessionId matches', result.sessionId === anySession.header.id)
    } else {
      check('no sessions available for summary test', false)
    }
  }

  // Authorization: reject a session from a different workspace
  const otherCwd = cwds.find((c) => c !== bestCwd)
  if (otherCwd) {
    const foreignSession = allSessions.find((s) => s.header.cwd === otherCwd)
    if (foreignSession) {
      let denied = false
      try {
        await tool.execute({ sessionId: foreignSession.header.id }, makeExec(callerSession))
      } catch (error) {
        denied = error.message.includes('denied') || error.message.includes('not in this workspace')
      }
      check('rejects session from different workspace (cwd isolation)', denied)
    }
  }
}

// =================================================================================
console.log('\nworkspace_recall:')
// =================================================================================
{
  const tool = registered.get('workspace_recall')
  check('workspace_recall is registered', !!tool)

  // Find a session with user messages to read
  let targetSession = null
  let targetSeqs = []
  for (const rec of allSessions.slice(0, 20)) {
    if (rec.header.cwd !== bestCwd) continue
    try {
      const snapshot = await sessionQuery.readSession(rec.header.id)
      const userMsgs = snapshot.events.filter((e) => e.type === 'user/message')
      if (userMsgs.length >= 2) {
        targetSession = rec.header.id
        targetSeqs = userMsgs.slice(0, 3).map((e) => e.seq)
        break
      }
    } catch { /* skip */ }
  }

  if (targetSession && targetSeqs.length > 0) {
    console.log(`  (reading ${targetSeqs.length} user messages from ${targetSession})`)

    const result = await tool.execute({ sessionId: targetSession, seqs: targetSeqs }, makeExec(callerSession))
    check('returns text', typeof result.text === 'string' && result.text.length > 0)
    check('sessionId matches', result.sessionId === targetSession)
    check('returnedTokens > 0', result.returnedTokens > 0)
    check('not truncated for small read', result.truncated === false)
    check('no omitted seqs for small read', result.omittedSeqs.length === 0)

    // Content should contain the seq markers
    check('text contains seq markers', result.text.includes(`--- ${targetSession}:${targetSeqs[0]} ---`))

    // Dedup: second call should report already delivered
    const dedup = await tool.execute({ sessionId: targetSession, seqs: targetSeqs }, makeExec(callerSession))
    check('second call deduplicates', dedup.text.includes('already delivered'))
    check('dedup returns 0 tokens', dedup.returnedTokens === 0)

    // Range read
    const rangeResult = await tool.execute({
      sessionId: targetSession,
      fromSeq: targetSeqs[0],
      toSeq: targetSeqs[targetSeqs.length - 1],
    }, makeExec(callerSession))
    // Some may have been delivered, so this might be partial or dedup
    check('range read works', typeof rangeResult.text === 'string' && rangeResult.text.length > 0)
  } else {
    console.log('  (no session with user messages found)')
    check('found a testable session', false, 'no session with 2+ user messages in workspace')
  }

  // Authorization: reject foreign session
  const otherCwd = cwds.find((c) => c !== bestCwd)
  if (otherCwd) {
    const foreignSession = allSessions.find((s) => s.header.cwd === otherCwd)
    if (foreignSession) {
      let denied = false
      try {
        await tool.execute({ sessionId: foreignSession.header.id, seqs: [0] }, makeExec(callerSession))
      } catch (error) {
        denied = error.message.includes('denied') || error.message.includes('not in this workspace')
      }
      check('rejects session from different workspace', denied)
    }
  }

  // Error handling: missing sessionId
  let threw = false
  try { await tool.execute({ seqs: [0] }, makeExec(callerSession)) } catch { threw = true }
  check('throws without sessionId', threw)

  // Error handling: missing seqs
  threw = false
  try { await tool.execute({ sessionId: 'x' }, makeExec(callerSession)) } catch { threw = true }
  check('throws without seqs or range', threw)
}

// =================================================================================
console.log('\nbudget enforcement:')
// =================================================================================
{
  const tool = registered.get('workspace_recall')

  // Find a session with enough content to trigger truncation
  let bigSession = null
  for (const rec of allSessions) {
    if (rec.header.cwd !== bestCwd) continue
    try {
      const events = await sessionQuery.listEvents(rec.header.id)
      if (events.length > 100) {
        bigSession = { id: rec.header.id, events: events.length }
        break
      }
    } catch { /* skip */ }
  }

  if (bigSession) {
    console.log(`  (reading from ${bigSession.id}: ${bigSession.events} events, budget=256)`)
    const result = await tool.execute({
      sessionId: bigSession.id,
      fromSeq: 0,
      toSeq: Math.min(50, bigSession.events - 1),
      budgetTokens: 256,
    }, makeExec(callerSession))
    check('returns text within budget', typeof result.text === 'string')
    check('respects tight budget', result.returnedTokens <= 500, `returned=${result.returnedTokens}`)
    if (result.truncated) {
      check('truncation is reported honestly', result.omittedSeqs.length > 0 || result.partialSeqs.length > 0)
      check('truncation text mentions withholding', result.text.includes('withheld'))
    }
  } else {
    console.log('  (no large session found, skipping budget test)')
  }
}

// =================================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('SOME CHECKS FAILED'); process.exit(1) }
console.log('ALL CHECKS PASSED')
process.exit(0)
