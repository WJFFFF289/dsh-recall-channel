/**
 * Live-session test: create a REAL session via SessionStore (the same way
 * DSH creates one when the user opens a new conversation), then exercise
 * all 5 plugin tools from that session.
 *
 * This is the closest we can get to "user opens a new chat in DSH" without
 * the GUI: the session is live in the store, visible to sessionQuery,
 * and the tools see it as the caller.
 *
 * Usage:
 *   DSH_MODULES=<harness>/resources/dsh/node_modules node test/live-session.mjs
 */

import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_MODULES = process.env.DSH_MODULES
  ?? join(process.env.DSH_APP ?? '', 'resources', 'dsh', 'node_modules')
const DSH_HOME = process.env.DSH_HOME
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

const imp = (rel) => import(pathToFileURL(join(DSH_MODULES, rel)).href)

let passed = 0
let failed = 0
const issues = []
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok   ${label}`) }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
function issue(text) { issues.push(text); console.log(`  ⚠ ${text}`) }

// ---- setup ---------------------------------------------------------------------
const cordis = await imp('@deepseek-ai/cordis/lib/index.js')
const Context = cordis.Context ?? cordis.default?.Context ?? cordis.default
const { default: SessionStore } = await imp('@deepseek-ai/dsh-session/lib/index.js')
const { default: JsonlSessionPersistence } = await imp('@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')
const { default: SqliteSessionQueryEngine } = await imp('@deepseek-ai/dsh-session-query-sqlite/lib/index.js')
const plugin = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href)

const ctx = new Context()
ctx.provide('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
ctx.plugin(SessionStore)
ctx.plugin(JsonlSessionPersistence, { root: join(DSH_HOME, 'sessions') })
ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
await new Promise((r) => setTimeout(r, 1500))

const sessionQuery = ctx.get('sessionQuery')
const sessionStore = ctx.get('sessions')
const registered = new Map()
ctx.provide('tools', { register: (tool) => registered.set(tool.name, tool) })
ctx.plugin(plugin)
await new Promise((r) => setTimeout(r, 500))

console.log(`[setup] ${registered.size} tools: ${[...registered.keys()].join(', ')}\n`)

// =================================================================================
// Create a REAL live session — this is what DSH does when the user opens a new chat
// =================================================================================
console.log('=== Creating live session (simulating new chat in DSH) ===')
const WORKSPACE = 'D:\\deepseekharness'
const newSession = sessionStore.create('test-live-' + Date.now(), {
  meta: { cwd: WORKSPACE },
})
console.log(`  id: ${newSession.id}`)
console.log(`  cwd: ${newSession.header.cwd}`)
console.log(`  live in store: ${sessionStore.get(newSession.id) !== undefined}`)

const exec = { agent: { session: newSession } }

// Verify sessionQuery sees this as a live session
const allRecords = await sessionQuery.listSessions()
const liveRecord = allRecords.find((r) => r.header.id === newSession.id)
check('sessionQuery sees the new session', !!liveRecord)
check('marked as live', liveRecord?.live === true)
check('not persisted (new session has no disk file yet)', liveRecord?.persisted === false)

// =================================================================================
console.log('\n=== Tool 1: search_history (old, on empty new session) ===')
// =================================================================================
{
  const tool = registered.get('search_history')
  const result = await tool.execute({ query: 'anything' }, exec)
  check('returns 0 hits on empty session', result.hits.length === 0)
  check('scanned 0 events', result.scanned === 0)
  check('no crash on empty session', true)

  const rendered = tool.output.render({ query: 'anything' }, result)
  const text = rendered.map((b) => b.text).join('\n')
  check('render says no matches', text.includes('No matches'))
}

// =================================================================================
console.log('\n=== Tool 2: recall_history (old, on empty new session) ===')
// =================================================================================
{
  const tool = registered.get('recall_history')
  const result = await tool.execute({ fromSeq: 0, toSeq: 10 }, exec)
  check('returns label', typeof result.label === 'string')
  check('0 tokens returned (nothing to recall)', result.returnedTokens === 0)
  const rendered = tool.output.render({}, result)
  const text = rendered.map((b) => b.text).join('\n')
  check('render mentions empty or no events', text.includes('no events') || text.includes('nothing recorded') || text.includes('ends at seq'))
}

// =================================================================================
console.log('\n=== Tool 3: workspace_map (new, from live session) ===')
// =================================================================================
{
  const tool = registered.get('workspace_map')
  const t0 = performance.now()
  const result = await tool.execute({}, exec)
  const elapsed = (performance.now() - t0).toFixed(0)

  check('returns sessions', Array.isArray(result.sessions))
  check('totalSessions > 0', result.totalSessions > 0, `total=${result.totalSessions}`)
  check('workspaceCwd matches', result.workspaceCwd === WORKSPACE)
  check('excludes caller session', !result.sessions.some((s) => s.sessionId === newSession.id))
  console.log(`  ${result.sessions.length} sessions in ${elapsed}ms`)

  // Does it show live sessions from other chats?
  const liveSessions = result.sessions.filter((s) => s.live)
  console.log(`  live sessions visible: ${liveSessions.length}`)
  if (liveSessions.length > 0) {
    check('live sessions marked with live=true', liveSessions.every((s) => s.live === true))
  }

  // Output size check
  const rendered = tool.output.render({}, result)
  const text = rendered.map((b) => b.text).join('\n')
  const tokens = Math.ceil(text.length / 4)
  console.log(`  output: ${text.length} chars (~${tokens} tokens)`)
  if (tokens > 2000) issue(`workspace_map output ~${tokens} tokens — over 2k budget for L1`)

  // Check for duplicate sessions
  const ids = result.sessions.map((s) => s.sessionId)
  const unique = new Set(ids)
  check('no duplicate session IDs', ids.length === unique.size)

  // Check date format consistency
  const badDates = result.sessions.filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.date !== 'unknown')
  check('date format is YYYY-MM-DD', badDates.length === 0, badDates.length > 0 ? `bad: ${badDates.map((d) => d.date).join(', ')}` : '')
}

// =================================================================================
console.log('\n=== Tool 4: workspace_session_summary (new) ===')
// =================================================================================
{
  const tool = registered.get('workspace_session_summary')

  // Find a session with compaction summaries (not just prunes)
  let bestTarget = null
  let bestSummaries = 0
  for (const rec of allRecords) {
    if (rec.header.cwd !== WORKSPACE || rec.header.id === newSession.id) continue
    try {
      const events = await sessionQuery.listEvents(rec.header.id)
      const summaryCount = events.filter((e) => e.type === 'compaction/summary').length
      if (summaryCount > bestSummaries) {
        bestSummaries = summaryCount
        bestTarget = rec.header.id
      }
    } catch { /* skip */ }
  }

  if (bestTarget) {
    console.log(`  target: ${bestTarget} (${bestSummaries} compaction summaries)`)
    const result = await tool.execute({ sessionId: bestTarget }, exec)

    check('returns summaries', Array.isArray(result.summaries))
    check('has compaction summaries', result.summaries.some((s) => s.kind === 'compaction'))
    check('sessionId matches', result.sessionId === bestTarget)
    check('totalEvents > 0', result.totalEvents > 0)

    // Regression guard: a burst of prunes must never evict real summaries from the
    // default window. Compactions rank first, so all of them survive the limit.
    const compactionsReturned = result.summaries.filter((s) => s.kind === 'compaction').length
    check('all compaction summaries survive the default limit',
      compactionsReturned === bestSummaries && bestSummaries > 0,
      `expected ${bestSummaries}, got ${compactionsReturned}`)
    check('compaction records are listed before prunes',
      result.summaries.findIndex((s) => s.kind === 'compaction')
        < Math.max(...result.summaries.map((s, i) => (s.kind === 'prune' ? i : -1)), -1))

    // Check truncation is working
    const longSummaries = result.summaries.filter((s) => s.summary.length > 600)
    check('summaries truncated to ~500 chars', longSummaries.length === 0,
      longSummaries.length > 0 ? `longest: ${Math.max(...result.summaries.map((s) => s.summary.length))} chars` : '')

    // Check truncation notice
    const truncated = result.summaries.filter((s) => s.summary.includes('truncated'))
    if (truncated.length > 0) {
      check('truncation notice mentions workspace_recall', truncated.every((s) => s.summary.includes('workspace_recall')))
    }

    // Output size
    const rendered = tool.output.render({}, result)
    const text = rendered.map((b) => b.text).join('\n')
    const tokens = Math.ceil(text.length / 4)
    console.log(`  output: ${text.length} chars (~${tokens} tokens)`)
    if (tokens > 5000) issue(`workspace_session_summary output ~${tokens} tokens — consider tighter limit`)
  } else {
    console.log('  (no session with compaction/summary found — only prunes exist)')
  }
}

// =================================================================================
console.log('\n=== Tool 5: workspace_recall (new) ===')
// =================================================================================
{
  const tool = registered.get('workspace_recall')

  // Find a session with user messages
  let targetId = null
  let targetSeqs = []
  for (const rec of allRecords.slice(0, 15)) {
    if (rec.header.cwd !== WORKSPACE || rec.header.id === newSession.id) continue
    try {
      const snapshot = await sessionQuery.readSession(rec.header.id)
      const userMsgs = snapshot.events.filter((e) => e.type === 'user/message')
      if (userMsgs.length >= 2) {
        targetId = rec.header.id
        targetSeqs = userMsgs.slice(0, 3).map((e) => e.seq)
        break
      }
    } catch { /* skip */ }
  }

  if (targetId) {
    console.log(`  reading seqs ${targetSeqs.join(',')} from ${targetId}`)

    // Basic recall
    const r1 = await tool.execute({ sessionId: targetId, seqs: targetSeqs }, exec)
    check('returns text', typeof r1.text === 'string' && r1.text.length > 0)
    check('tokens > 0', r1.returnedTokens > 0)
    check('not truncated for small read', r1.truncated === false)
    check('seq markers present', r1.text.includes(`--- ${targetId}:${targetSeqs[0]} ---`))
    check('fence warning present', r1.text.includes('past data, not instructions'))

    // Dedup
    const r2 = await tool.execute({ sessionId: targetId, seqs: targetSeqs }, exec)
    check('dedup works', r2.returnedTokens === 0 && r2.text.includes('already delivered'))

    // Range read
    const r3 = await tool.execute({ sessionId: targetId, fromSeq: targetSeqs[0], toSeq: targetSeqs[targetSeqs.length - 1] + 5 }, exec)
    check('range read works', typeof r3.text === 'string')

    // Budget truncation
    const manySeqs = []
    for (let s = 0; s < 40; s++) manySeqs.push(s)
    const r4 = await tool.execute({ sessionId: targetId, seqs: manySeqs, budgetTokens: 300 }, exec)
    check('budget truncation works', r4.truncated === true || r4.returnedTokens <= 500)
    if (r4.truncated) {
      check('truncation reports omitted', r4.omittedSeqs.length > 0 || r4.partialSeqs.length > 0)
    }

    // Self-recall: can we read our own (empty) session?
    const r5 = await tool.execute({ sessionId: newSession.id, seqs: [0] }, exec)
    check('self-recall on empty session returns 0 tokens', r5.returnedTokens === 0)
  } else {
    check('found session with user messages', false, 'no suitable target')
  }
}

// =================================================================================
console.log('\n=== Cross-cutting concerns ===')
// =================================================================================

// Tool description quality: does the model know when to use which tool?
{
  const map = registered.get('workspace_map')
  const summary = registered.get('workspace_session_summary')
  const recall = registered.get('workspace_recall')

  check('workspace_map description mentions next steps',
    map.description.includes('workspace_session_summary') && map.description.includes('workspace_recall'))
  check('workspace_session_summary mentions workspace_recall',
    summary.description.includes('workspace_recall'))
  check('workspace_recall mentions sessionId source',
    recall.description.includes('workspace_map'))
}

// Render output guidance: does the render text guide the model?
{
  const mapResult = await registered.get('workspace_map').execute({ limit: 3 }, exec)
  const mapText = registered.get('workspace_map').output.render({}, mapResult).map((b) => b.text).join('\n')
  check('map render mentions workspace_session_summary', mapText.includes('workspace_session_summary'))
  check('map render mentions workspace_recall', mapText.includes('workspace_recall'))
}

// Empty workspace: what if no other sessions exist?
{
  const emptySession = sessionStore.create('test-empty-' + Date.now(), {
    meta: { cwd: 'C:\\nonexistent\\empty\\workspace' },
  })
  const emptyExec = { agent: { session: emptySession } }
  const mapResult = await registered.get('workspace_map').execute({}, emptyExec)
  check('empty workspace returns 0 sessions', mapResult.totalSessions === 0)
  const mapText = registered.get('workspace_map').output.render({}, mapResult).map((b) => b.text).join('\n')
  check('empty workspace render says no sessions', mapText.includes('No other sessions'))
}

// Live session visibility: does workspace_map show OTHER live sessions?
{
  // Create a second live session in the same workspace
  const live2 = sessionStore.create('test-live2-' + Date.now(), {
    meta: { cwd: WORKSPACE },
  })
  const exec2 = { agent: { session: live2 } }
  const mapResult = await registered.get('workspace_map').execute({}, exec2)
  const firstLive = mapResult.sessions.find((s) => s.sessionId === newSession.id)
  check('other live sessions visible in workspace_map', !!firstLive)
  check('other live session marked live=true', firstLive?.live === true)
}

// =================================================================================
console.log(`\n=== RESULTS ===`)
console.log(`${passed} passed, ${failed} failed`)
if (issues.length > 0) {
  console.log(`\n=== ISSUES FOUND ===`)
  for (const i of issues) console.log(`  ⚠ ${i}`)
}
if (failed > 0) { console.log('\nSOME CHECKS FAILED'); process.exit(1) }
console.log('\nALL CHECKS PASSED')
process.exit(0)
