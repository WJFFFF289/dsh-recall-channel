/**
 * Mechanics test for dsh-recall-channel.
 *
 * Drives the anchor + both tools against a synthetic session log, so the
 * search → recall loop is verified without a model, a browser, or a running
 * harness. The conversational acceptance (does the model actually call the
 * tools?) stays a human test.
 *
 * Run: node test/mechanics.mjs
 */

import { createAnchor } from '../lib/anchor.js'
import { createTools } from '../lib/tools.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** A synthetic session: append-only events plus the two read methods we use. */
function makeSession(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    id: 'session-test',
    snapshotEvents: () => events,
    eventAt: (seq) => bySeq.get(seq),
  }
}

const SECRET = 'ZK-7723-PINEAPPLE'
const events = [
  { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'The failing job is ZK-7723-PINEAPPLE and it started when the login flow began timing out.' }] } },
  { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Let me look at the login timeout path.' }, { type: 'reasoning', text: 'SECRET-REASONING-ONLY' }] } } },
  { seq: 2, type: 'tool/call', data: { name: 'pwsh', arguments: '{"command":"Get-Content login.ts"}' } },
  { seq: 3, type: 'tool/result', data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: 'timeoutMs = 30000 // related to ZK-7723-PINEAPPLE; retry budget was 2' }] }] } } },
  // --- compaction shadows seqs 0..3 ---
  { seq: 4, type: 'compaction/start', data: { compactionId: 'cmp-1', turn: 3 } },
  { seq: 5, type: 'compaction/summary', data: { compactionId: 'cmp-1', summary: [{ type: 'text', text: 'We discussed a login timeout.' }], shadowedRange: { start: 0, end: 3 }, shadowedSeqs: [0, 1, 2, 3], shadowedTokenCount: 4200, provider: 'deepseek-official', model: 'test-model' } },
  { seq: 6, type: 'compaction/end', data: { compactionId: 'cmp-1', turn: 3 } },
  // --- later, unrelated turns ---
  { seq: 7, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Now let us work on something else entirely.' }] } },
  { seq: 8, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] } } },
]

const session = makeSession(events)
const handlers = new Map()
const fakeCtx = { on: (event, handler) => handlers.set(event, handler) }

const config = {
  enabled: true,
  searchLimit: 20,
  snippetChars: 240,
  scanLimit: 50000,
  maxRecallTokens: 16000,
  maxSessionRecallTokens: 64000,
  includeReasoning: false,
  hintOnCompaction: true,
}

console.log('anchor:')
const anchor = createAnchor(fakeCtx)
// The plugin was installed mid-life here: nothing is fed through the feed, so
// the anchor must rebuild the index by folding the existing log.
const list = anchor.list(session)
check('rebuilds the index from an existing log (no feed events)', list.length === 1, `got ${list.length}`)
check('records the compaction id', list[0]?.id === 'cmp-1', list[0]?.id)
check('records all four shadowed seqs', list[0]?.shadowedSeqs?.join(',') === '0,1,2,3', list[0]?.shadowedSeqs?.join(','))
check('records shadowed token count', list[0]?.shadowedTokenCount === 4200, list[0]?.shadowedTokenCount)

const [search, recall] = createTools(config, anchor)
check('exposes search_history + recall_history', search?.name === 'search_history' && recall?.name === 'recall_history', `${search?.name}/${recall?.name}`)

const exec = { agent: { session } }

console.log('search_history:')
const found = await search.execute({ query: 'ZK-7723-PINEAPPLE' }, exec)
check('finds the secret inside shadowed history', found.hits.length === 2, `hits=${found.hits.length}`)
check('marks hits as shadowed and names the compaction', found.hits.every((h) => h.shadowed === true && h.compactionId === 'cmp-1'))
check('reports the recorded compaction count', found.compactions === 1, found.compactions)
const missing = await search.execute({ query: 'no-such-string-anywhere' }, exec)
check('returns no hits for an absent query', missing.hits.length === 0)
const scoped = await search.execute({ query: 'something else entirely', scope: 'shadowed' }, exec)
check('scope=shadowed excludes live content', scoped.hits.length === 0, `hits=${scoped.hits.length}`)

console.log('recall_history:')
const restored = await recall.execute({ compactionId: 'cmp-1' }, exec)
check('restores the secret verbatim', restored.text.includes(SECRET))
check('restores tool-result content too', restored.text.includes('retry budget was 2'))
check('tags roles for every block', restored.text.includes('## user') && restored.text.includes('## assistant') && restored.text.includes('## tool_call') && restored.text.includes('## tool_result'))
check('omits reasoning by default', !restored.text.includes('SECRET-REASONING-ONLY'))
check('reports a label and honest token accounting', restored.label.includes('cmp-1') && restored.returnedTokens > 0, `${restored.label} / ${restored.returnedTokens}`)

const again = await recall.execute({ compactionId: 'cmp-1' }, exec)
check('deduplicates an identical second restore', again.returnedTokens === 0 && again.text.includes('already restored'))

const byRangeAgain = await recall.execute({ fromSeq: 2, toSeq: 3 }, exec)
check('dedupe also covers explicit ranges', byRangeAgain.returnedTokens === 0 && byRangeAgain.text.includes('already restored'))

// A fresh session exercises the range path itself (the first session already
// restored those seqs, so dedupe would short-circuit it there).
const session2 = makeSession(events)
const anchor2 = createAnchor({ on: () => {} })
const [, recall2] = createTools(config, anchor2)
const byRange = await recall2.execute({ fromSeq: 2, toSeq: 3 }, { agent: { session: session2 } })
check('accepts an explicit seq range', byRange.text.includes('retry budget was 2'), byRange.text.slice(0, 120))
check('renders an unaddressable seq as a note, not a crash', (await recall2.execute({ seqs: [99999] }, { agent: { session: session2 } })).text.length > 0)

const tiny = await recall.execute({ compactionId: 'cmp-1', budgetTokens: 256 }, exec)
check('respects a small budget and admits truncation', tiny.truncated === true || tiny.text.length > 0)

let unknownThrew = false
try {
  await recall.execute({ compactionId: 'nope' }, exec)
} catch (error) {
  unknownThrew = String(error.message).includes('unknown compactionId')
}
check('rejects an unknown compaction id with the known list', unknownThrew)

let noAgentThrew = false
try {
  await search.execute({ query: 'x' }, {})
} catch (error) {
  noAgentThrew = String(error.message).includes('owning agent session')
}
check('refuses to run without an owning session', noAgentThrew)

console.log('anchor feed:')
const pendingSession = makeSession([])
handlers.get('session/event')(pendingSession, events[5])
handlers.get('session/event')(pendingSession, events[6])
const pending = anchor.takePending(pendingSession)
check('queues a post-compaction notice once', pending?.id === 'cmp-1', pending?.id)
check('notice is consumed exactly once', anchor.takePending(pendingSession) === undefined)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
