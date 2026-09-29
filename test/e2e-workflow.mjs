/**
 * End-to-end workflow test: simulate a new session starting up and using
 * workspace tools to recover context — with performance timing.
 *
 * Simulates the exact sequence a model would follow:
 *   1. workspace_map        → what sessions exist?
 *   2. workspace_session_summary → what did session X do?
 *   3. workspace_recall     → read the original text of specific events
 *
 * Also measures timing to identify optimization opportunities.
 *
 * Usage:
 *   DSH_MODULES=<harness>/resources/dsh/node_modules node test/e2e-workflow.mjs
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

// ---- setup --------------------------------------------------------------------
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
const registered = new Map()
ctx.provide('tools', { register: (tool) => registered.set(tool.name, tool) })
ctx.plugin(plugin)
await new Promise((r) => setTimeout(r, 500))

console.log(`[setup] ${registered.size} tools registered\n`)

// ---- pick a workspace -----------------------------------------------------------
const allSessions = await sessionQuery.listSessions()
const cwdCounts = {}
for (const s of allSessions) {
  const cwd = s.header.cwd
  if (cwd) cwdCounts[cwd] = (cwdCounts[cwd] || 0) + 1
}
const bestCwd = Object.entries(cwdCounts).sort((a, b) => b[1] - a[1])[0][0]
const sessionCount = cwdCounts[bestCwd]
console.log(`[setup] workspace: ${bestCwd} (${sessionCount} sessions)\n`)

// Mock caller session
const callerSession = {
  id: 'e2e-test-caller-00000000',
  header: { id: 'e2e-test-caller-00000000', cwd: bestCwd, createdAt: Date.now() },
  snapshotEvents: () => [],
  eventAt: () => undefined,
}
const exec = { agent: { session: callerSession } }

// ---- helpers ----------------------------------------------------------------------
function elapsed(start) { return `${(performance.now() - start).toFixed(0)}ms` }
function renderText(tool, args, result) {
  return tool.output.render(args, result).map((b) => b.text).join('\n')
}

const issues = [] // collect optimization findings

// =================================================================================
// STEP 1: workspace_map — "new session starts, what's here?"
// =================================================================================
console.log('=== STEP 1: workspace_map ===')
const mapTool = registered.get('workspace_map')

let t0 = performance.now()
const mapResult = await mapTool.execute({}, exec)
const mapTime = performance.now() - t0
console.log(`  ${mapResult.totalSessions} sessions found in ${elapsed(t0)}`)
console.log(`  returned ${mapResult.sessions.length} session entries`)

if (mapTime > 3000) issues.push(`workspace_map slow: ${mapTime.toFixed(0)}ms for ${mapResult.sessions.length} sessions — consider lazy title/event loading`)

// Show first 5 entries
for (const s of mapResult.sessions.slice(0, 5)) {
  console.log(`  ${s.sessionId.slice(0, 20)}… | ${s.date} | ${s.title.slice(0, 40)} | ${s.events} ev, ${s.compactions} cmp`)
}
if (mapResult.sessions.length > 5) console.log(`  … +${mapResult.sessions.length - 5} more`)

// Verify all sessions are from the right workspace
const foreignCount = mapResult.sessions.filter((s) => s.sessionId === callerSession.id).length
console.log(`  caller excluded: ${foreignCount === 0 ? 'yes' : 'NO (BUG)'}`)

// Rendered output size
const mapText = renderText(mapTool, {}, mapResult)
const mapTokens = Math.ceil(mapText.length / 4)
console.log(`  rendered output: ${mapText.length} chars (~${mapTokens} tokens)`)
if (mapTokens > 2000) issues.push(`workspace_map output large: ~${mapTokens} tokens for ${mapResult.sessions.length} sessions — consider per-session line trimming`)

// =================================================================================
// STEP 2: workspace_session_summary — "what did that big session do?"
// =================================================================================
console.log('\n=== STEP 2: workspace_session_summary ===')
const summaryTool = registered.get('workspace_session_summary')

// Find the session with the most compaction events
let targetSession = null
let maxCompactions = 0
for (const s of mapResult.sessions) {
  if (s.compactions > maxCompactions) {
    maxCompactions = s.compactions
    targetSession = s.sessionId
  }
}

if (targetSession) {
  console.log(`  target: ${targetSession} (${maxCompactions} compactions)`)

  t0 = performance.now()
  const summaryResult = await summaryTool.execute({ sessionId: targetSession }, exec)
  const summaryTime = performance.now() - t0
  console.log(`  ${summaryResult.summaries.length} summaries in ${elapsed(t0)}`)
  console.log(`  session has ${summaryResult.totalEvents} total events`)

  if (summaryTime > 2000) issues.push(`workspace_session_summary slow: ${summaryTime.toFixed(0)}ms for ${summaryResult.totalEvents} events — readSession is full-log`)

  for (const s of summaryResult.summaries.slice(0, 3)) {
    console.log(`  [${s.kind}] seq=${s.seq} shadowed=${s.shadowedCount} seqs=${s.seqRange} ~${s.shadowedTokens}tok`)
    console.log(`    ${s.summary.slice(0, 120).replace(/\n/g, ' ')}…`)
  }
  if (summaryResult.summaries.length > 3) console.log(`  … +${summaryResult.summaries.length - 3} more`)

  const summaryText = renderText(summaryTool, { sessionId: targetSession }, summaryResult)
  const summaryTokens = Math.ceil(summaryText.length / 4)
  console.log(`  rendered output: ${summaryText.length} chars (~${summaryTokens} tokens)`)
  if (summaryTokens > 5000) issues.push(`workspace_session_summary output large: ~${summaryTokens} tokens — consider summary truncation`)

  // =================================================================================
  // STEP 3: workspace_recall — "read the original text of those events"
  // =================================================================================
  console.log('\n=== STEP 3: workspace_recall ===')
  const recallTool = registered.get('workspace_recall')

  // Pick shadowed seqs from the first summary
  const firstSummary = summaryResult.summaries[0]
  if (firstSummary && firstSummary.seqRange !== 'none') {
    const [lo, hi] = firstSummary.seqRange.split('–').map(Number)
    // Read a few events from the shadowed range
    const readCount = Math.min(5, hi - lo + 1)
    const seqs = []
    for (let s = lo; s < lo + readCount; s++) seqs.push(s)

    console.log(`  reading seqs ${seqs.join(',')} from ${targetSession}`)

    t0 = performance.now()
    const recallResult = await recallTool.execute({ sessionId: targetSession, seqs }, exec)
    const recallTime = performance.now() - t0
    console.log(`  ${recallResult.returnedTokens} tokens returned in ${elapsed(t0)}`)
    console.log(`  truncated: ${recallResult.truncated}`)

    if (recallTime > 3000) issues.push(`workspace_recall slow: ${recallTime.toFixed(0)}ms — readSession loads the full log for a few seqs; consider readEvent for targeted reads`)

    // Show a snippet of what was recalled
    const bodyStart = recallResult.text.indexOf('---')
    if (bodyStart >= 0) {
      const snippet = recallResult.text.slice(bodyStart, bodyStart + 300).replace(/\n/g, ' ')
      console.log(`  content preview: ${snippet}…`)
    }

    // Dedup check
    t0 = performance.now()
    const dedupResult = await recallTool.execute({ sessionId: targetSession, seqs }, exec)
    console.log(`  dedup: ${dedupResult.returnedTokens} tokens (${dedupResult.text.includes('already delivered') ? 'correctly deduped' : 'NOT deduped (BUG)'})`)
  }

  // Budget truncation test
  console.log('\n=== STEP 3b: budget truncation ===')
  const bigRangeSeqs = []
  for (let s = 0; s < Math.min(30, summaryResult.totalEvents); s++) bigRangeSeqs.push(s)

  t0 = performance.now()
  const budgetResult = await recallTool.execute({ sessionId: targetSession, seqs: bigRangeSeqs, budgetTokens: 512 }, exec)
  console.log(`  30 seqs with budget=512: ${budgetResult.returnedTokens} tokens, truncated=${budgetResult.truncated}, omitted=${budgetResult.omittedSeqs.length}, partial=${budgetResult.partialSeqs.length}`)
  if (budgetResult.truncated && !budgetResult.text.includes('withheld')) {
    issues.push('workspace_recall truncated but did not report withholding in text')
  }
} else {
  console.log('  no session with compaction events found — skipping L2/L3')
}

// =================================================================================
// STEP 4: error paths
// =================================================================================
console.log('\n=== STEP 4: error paths ===')

// Non-existent session
{
  const recallTool = registered.get('workspace_recall')
  try {
    await recallTool.execute({ sessionId: 'nonexistent-session-id', seqs: [0] }, exec)
    console.log('  FAIL: nonexistent session should throw')
    issues.push('workspace_recall does not throw for nonexistent session')
  } catch (e) {
    console.log(`  nonexistent session: throws "${e.message.slice(0, 80)}"`)
  }
}

// Cross-workspace denial
{
  const otherCwd = Object.keys(cwdCounts).find((c) => c !== bestCwd)
  if (otherCwd) {
    const foreign = allSessions.find((s) => s.header.cwd === otherCwd)
    if (foreign) {
      try {
        await registered.get('workspace_recall').execute({ sessionId: foreign.header.id, seqs: [0] }, exec)
        console.log('  FAIL: cross-workspace should be denied')
        issues.push('workspace_recall does not deny cross-workspace access')
      } catch (e) {
        console.log(`  cross-workspace denied: "${e.message.slice(0, 80)}"`)
      }
    }
  }
}

// =================================================================================
// STEP 5: performance summary
// =================================================================================
console.log('\n=== PERFORMANCE ===')
{
  // Time individual API calls for reference
  const targetId = mapResult.sessions[0]?.sessionId
  if (targetId) {
    t0 = performance.now()
    await sessionQuery.readTitle(targetId)
    console.log(`  readTitle:    ${elapsed(t0)}`)

    t0 = performance.now()
    await sessionQuery.listEvents(targetId)
    console.log(`  listEvents:   ${elapsed(t0)}`)

    t0 = performance.now()
    await sessionQuery.readSession(targetId)
    console.log(`  readSession:  ${elapsed(t0)}`)

    t0 = performance.now()
    await sessionQuery.filterSessions([{ kind: 'cwd', values: [bestCwd] }])
    console.log(`  filterSessions: ${elapsed(t0)}`)
  }
}

// =================================================================================
// Findings
// =================================================================================
console.log('\n=== FINDINGS ===')
if (issues.length === 0) {
  console.log('  no issues found')
} else {
  for (const issue of issues) console.log(`  ⚠ ${issue}`)
}

console.log('\nDone.')
process.exit(0)
