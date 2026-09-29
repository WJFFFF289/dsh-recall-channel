/**
 * Mechanics test for dsh-recall-channel.
 *
 * Drives the anchor + both tools against synthetic session logs, so the
 * search → recall loop is verified without a model, a browser, or a running
 * harness. The conversational acceptance (does the model actually call the
 * tools?) stays a human test.
 *
 * Run: node test/mechanics.mjs
 */

import { createAnchor } from '../lib/anchor.js'
import { createTools } from '../lib/tools.js'
import { estimateTokens } from '../lib/metrics.js'
import { createNoticeTracker, isOwnSource, noticeText, reminderText, PLUGIN_ID, PRODUCER_KIND } from '../lib/notice.js'
import { Config, apply } from '../lib/index.js'

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
    seq: events.length,
    snapshotEvents: () => events,
    eventAt: (seq) => bySeq.get(seq),
  }
}

const CONFIG = {
  enabled: true,
  searchLimit: 20,
  snippetChars: 240,
  scanLimit: 200000,
  maxRecallTokens: 16000,
  maxSessionRecallTokens: 64000,
  blockChars: 0,
  argChars: 0,
  searchTextChars: 200000,
  maxRangeSeqs: 200000,
  allowRegex: true,
  regexMaxPatternChars: 200,
  regexInputChars: 20000,
  regexBudgetMs: 250,
  includeReasoning: false,
  hintOnCompaction: true,
  notifyOnPrune: true,
  noticeRefresh: true,
  wrapRecalledText: true,
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

const config = CONFIG

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
check('reports the recorded shadow count', found.shadowRecords === 1, found.shadowRecords)
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
check('every requested event was delivered in full', restored.omittedSeqs.length === 0 && restored.partialSeqs.length === 0 && restored.skippedSeqs.length === 0, `omitted=${restored.omittedSeqs} partial=${restored.partialSeqs}`)

const again = await recall.execute({ compactionId: 'cmp-1' }, exec)
check('deduplicates an identical second restore', again.returnedTokens === 0 && again.text.includes('already delivered'), again.text.slice(0, 90))

const byRangeAgain = await recall.execute({ fromSeq: 2, toSeq: 3 }, exec)
check('dedupe also covers explicit ranges', byRangeAgain.returnedTokens === 0 && byRangeAgain.text.includes('already delivered'))

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
check('rejects an unknown compaction id', unknownThrew)

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
check('queues a post-compaction notice once', pending.length === 1 && pending[0].id === 'cmp-1', JSON.stringify(pending.map((p) => p.id)))
check('notice is consumed exactly once', anchor.takePending(pendingSession).length === 0)

// ---------------------------------------------------------------------------
// v1.1 regression suite
// ---------------------------------------------------------------------------

/** `count` events, each `chars` long, self-describing. */
function filler(count, chars, prefix) {
  const out = []
  for (let index = 0; index < count; index += 1) {
    const head = `${prefix}-${index} `
    out.push({
      seq: index,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: head + 'x'.repeat(Math.max(0, chars - head.length - 1)) + '#' }] },
    })
  }
  return out
}

console.log('delivery ledger (the paging wedge):')
{
  const local = makeSession(filler(5, 400, 'EVENT'))
  const localAnchor = createAnchor({ on: () => {} })
  const [, localRecall] = createTools(config, localAnchor)
  const localExec = { agent: { session: local } }

  const wide = await localRecall.execute({ fromSeq: 0, toSeq: 4, budgetTokens: 256 }, localExec)
  check('a clipped call reports head/tail withholding', wide.truncated === true && wide.omittedBytes > 0, `truncated=${wide.truncated} omittedBytes=${wide.omittedBytes}`)
  check('the body marks the seam with the exact byte count', wide.text.includes('withheld here') && wide.text.includes(`${wide.omittedBytes} bytes`))
  check('omitted and partial sets are disjoint and non-empty', wide.omittedSeqs.length > 0 && wide.omittedSeqs.every((seq) => !wide.partialSeqs.includes(seq)), `omitted=${wide.omittedSeqs} partial=${wide.partialSeqs}`)
  check('fully delivered events are the only ones sealed', wide.skippedSeqs.length === 0 && !wide.omittedSeqs.includes(0), `omitted=${wide.omittedSeqs}`)

  const withheldSeq = wide.omittedSeqs[0]
  const page = await localRecall.execute({ seqs: [withheldSeq], budgetTokens: 4000 }, localExec)
  check('THE WEDGE IS GONE: a withheld event stays readable', page.text.includes(`EVENT-${withheldSeq} `) && page.returnedTokens > 0, `returnedTokens=${page.returnedTokens}`)
  check('the paged read is a full delivery', page.omittedSeqs.length === 0 && page.partialSeqs.length === 0)

  const sealed = await localRecall.execute({ seqs: [0] }, localExec)
  check('an event delivered in full is still deduplicated', sealed.text.includes('already delivered') && sealed.returnedTokens === 0)
  check('a partially delivered event is not reported as sealed', !wide.skippedSeqs.includes(wide.partialSeqs[0]))
}

console.log('delivery ledger (starved session budget):')
{
  const local = makeSession(filler(3, 2000, 'BIG'))
  const localAnchor = createAnchor({ on: () => {} })
  const [, localRecall] = createTools({ ...config, maxSessionRecallTokens: 0 }, localAnchor)
  const localExec = { agent: { session: local } }
  const starved = await localRecall.execute({ fromSeq: 0, toSeq: 2 }, localExec)
  check('a starved call says nothing was delivered', starved.text.includes('Nothing was delivered') && starved.returnedTokens === 0, starved.text.slice(-160))
  check('a starved call does NOT claim the events were already restored', !starved.text.includes('already delivered'))
  const retry = await localRecall.execute({ fromSeq: 0, toSeq: 2 }, localExec)
  check('a starved call leaves the span unread (no ledger poisoning)', retry.text.includes('Nothing was delivered'), retry.text.slice(-160))
}

console.log('verbatim restore (no hidden shears):')
{
  const big = 'A'.repeat(7000) + 'NEEDLE-IN-THE-MIDDLE' + 'B'.repeat(4990)
  const local = makeSession([
    { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: big }] } },
  ])
  const localAnchor = createAnchor({ on: () => {} })
  const [localSearch, localRecall] = createTools(config, localAnchor)
  const localExec = { agent: { session: local } }

  const hit = await localSearch.execute({ query: 'NEEDLE-IN-THE-MIDDLE' }, localExec)
  check('search reaches past 6000 chars inside one block', hit.hits.length === 1 && hit.hits[0].seq === 0, `hits=${hit.hits.length}`)

  const full = await localRecall.execute({ seqs: [0], budgetTokens: 200000 }, localExec)
  check('a 12000-char block is restored verbatim', full.text.includes(big) && full.clippedEvents === 0, `clippedEvents=${full.clippedEvents}`)
  check('verbatim content is fenced as data, not instructions', full.text.startsWith('Historical replay') && full.text.includes('[end of replayed history]'))
  check('the fenced body is byte-identical to the source', full.text.includes(`--- seq 0 ---\n## user\n${big}`))
  check('reading text that is not shadowed is flagged, not silently billed', full.text.includes('not marked as shadowed'))
}

console.log('honest scanning:')
{
  const local = makeSession(filler(10, 30, 'ROW'))
  const last = local.snapshotEvents()[9]
  last.data.content[0].text += ' TAILONLY-MARKER'
  const localAnchor = createAnchor({ on: () => {} })
  const [localSearch] = createTools({ ...config, scanLimit: 5 }, localAnchor)
  const localExec = { agent: { session: local } }

  const limited = await localSearch.execute({ query: 'TAILONLY-MARKER' }, localExec)
  check('a scan-window miss sets scanTruncated', limited.hits.length === 0 && limited.scanTruncated === true, `hits=${limited.hits.length} scanTruncated=${limited.scanTruncated}`)
  const rendered = localSearch.output.render({}, limited)[0].text
  check('the rendered output says the rest was NOT searched', rendered.includes('NOT searched') && rendered.includes('No matches'), rendered.slice(0, 160))
}

console.log('caps and reporting:')
{
  const local = makeSession(filler(3, 100, 'CAP'))
  const localAnchor = createAnchor({ on: () => {} })
  const [localSearch, localRecall] = createTools({ ...config, searchTextChars: 40 }, localAnchor)
  const localExec = { agent: { session: local } }

  const capped = await localSearch.execute({ query: 'CAP-0' }, localExec)
  check('per-event search cap is reported, not silent', capped.clippedEvents === 3 && capped.clippedChars > 0, `events=${capped.clippedEvents} chars=${capped.clippedChars}`)

  const clipped = await localRecall.execute({ seqs: [0], budgetTokens: 200000 }, { agent: { session: local } })
  check('display cap 0 means no clip', clipped.clippedEvents === 0)
  const capped2 = createTools({ ...config, blockChars: 20 }, localAnchor)
  const shown = await capped2[1].execute({ seqs: [0], budgetTokens: 200000 }, localExec)
  check('an explicit blockChars cap is reported honestly', shown.clippedEvents === 1 && shown.clippedChars > 0, `events=${shown.clippedEvents} chars=${shown.clippedChars}`)
  check('a clipped block never reports truncated:false as if complete', shown.text.includes('Truncated by the configured size cap'))
}

console.log('host protection:')
{
  const local = makeSession(filler(4, 50, 'DOS'))
  const localAnchor = createAnchor({ on: () => {} })
  const [localSearch, localRecall] = createTools(config, localAnchor)
  const localExec = { agent: { session: local } }

  // An absurd span is clamped to what exists *before* anything is materialised.
  const started = Date.now()
  const absurd = await localRecall.execute({ fromSeq: 0, toSeq: 1000000000 }, { agent: { session: makeSession(filler(4, 50, 'DOS')) } })
  check('an astronomically wide range is clamped, never allocated', absurd.label === 'seqs 0–3' && Date.now() - started < 1000, `${absurd.label} in ${Date.now() - started}ms`)

  const clamped = await localRecall.execute({ fromSeq: -5, toSeq: 99 }, localExec)
  check('an out-of-range span is clamped to the real log', clamped.label === 'seqs 0–3' && clamped.text.includes('clamped'), clamped.label)

  // The span cap is the backstop for logs that are genuinely huge.
  const tinyRange = createTools({ ...config, maxRangeSeqs: 2 }, localAnchor)
  let spanThrew = false
  try {
    await tinyRange[1].execute({ fromSeq: 0, toSeq: 3 }, localExec)
  } catch (error) {
    spanThrew = String(error.message).includes('range too wide')
  }
  check('a span wider than maxRangeSeqs is refused', spanThrew)

  const started2 = Date.now()
  let redosThrew = false
  try {
    await localSearch.execute({ query: '(a+)+$', regex: true }, localExec)
  } catch (error) {
    redosThrew = String(error.message).includes('catastrophic')
  }
  check('a catastrophic pattern is refused in milliseconds', redosThrew && Date.now() - started2 < 250, `${Date.now() - started2}ms`)

  let longThrew = false
  try {
    await localSearch.execute({ query: 'a'.repeat(500), regex: true }, localExec)
  } catch (error) {
    longThrew = String(error.message).includes('too long')
  }
  check('an over-long pattern is refused', longThrew)

  const safe = await localSearch.execute({ query: 'DOS-\\d+', regex: true }, localExec)
  check('a safe pattern still works', safe.hits.length === 4, `hits=${safe.hits.length}`)

  const off = createTools({ ...config, allowRegex: false }, localAnchor)
  let offThrew = false
  try {
    await off[0].execute({ query: 'DOS', regex: true }, localExec)
  } catch (error) {
    offThrew = String(error.message).includes('disabled')
  }
  check('allowRegex:false refuses regex outright', offThrew)
}

console.log('CJK accounting:')
{
  check('CJK characters count as ~1 token each', estimateTokens('中'.repeat(100)) >= 100, estimateTokens('中'.repeat(100)))
  check('ASCII keeps the chars/4 density', estimateTokens('a'.repeat(100)) === 25, estimateTokens('a'.repeat(100)))

  const cjk = '中'.repeat(5000)
  const local = makeSession([{ seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: cjk }] } }])
  const localAnchor = createAnchor({ on: () => {} })
  const [, localRecall] = createTools(config, localAnchor)
  const out = await localRecall.execute({ seqs: [0], budgetTokens: 1000 }, { agent: { session: local } })
  check('a Chinese restore respects the budget in real tokens', out.truncated === true && estimateTokens(out.text) <= 1150, `tokens=${estimateTokens(out.text)}`)
}

console.log('code-point safety:')
{
  const padded = 'a'.repeat(5999) + '😀'.repeat(20)
  const local = makeSession([{ seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: padded }] } }])
  const localAnchor = createAnchor({ on: () => {} })
  const [, localRecall] = createTools({ ...config, blockChars: 6000 }, localAnchor)
  const out = await localRecall.execute({ seqs: [0], budgetTokens: 200000 }, { agent: { session: local } })
  check('clipping never strands half a surrogate pair', !out.text.includes('\ufffd'), 'U+FFFD present')
}

console.log('notices:')
{
  const tracker = createNoticeTracker()
  const key = {}
  tracker.recordNotice(key, 5)
  check('refresh is off before any notice is shadowed', tracker.shouldRefresh(key, { shadowedSeqSet: new Set([7]), latestShadowSeq: 9 }) === false)
  check('refresh fires once the standing notice is shadowed', tracker.shouldRefresh(key, { shadowedSeqSet: new Set([5]), latestShadowSeq: 9 }) === true)
  tracker.markRefreshed(key, 9)
  check('the same shadowing event never triggers twice', tracker.shouldRefresh(key, { shadowedSeqSet: new Set([5]), latestShadowSeq: 9 }) === false)
  check('a newer shadowing event triggers again', tracker.shouldRefresh(key, { shadowedSeqSet: new Set([5, 12]), latestShadowSeq: 12 }) === true)

  const entry = { id: 'cmp-9', kind: 'compaction', shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234 }
  const text = noticeText([entry])
  check('the notice names the compaction and the way back', text.includes('cmp-9') && text.includes('search_history') && text.includes('recall_history'))
  check('the reminder is terse and names both tools', reminderText([entry]).length < 400 && reminderText([entry]).includes('search_history'))
}

console.log('anchor bookkeeping:')
{
  const local = makeSession([])
  const localAnchor = createAnchor(fakeCtx)
  const feed = handlers.get('session/event')

  // A failed compaction emits compaction/end with an error and no summary.
  feed(local, { seq: 0, type: 'compaction/start', data: { compactionId: 'failed-1' } })
  feed(local, { seq: 1, type: 'compaction/end', data: { compactionId: 'failed-1', error: { name: 'CompactionError' } } })
  check('a failed compaction leaves no ghost record', localAnchor.list(local).length === 0 && localAnchor.get(local, 'failed-1') === undefined)

  // Two successful compactions inside one step must both be announced.
  feed(local, { seq: 2, type: 'compaction/summary', data: { compactionId: 'A', shadowedSeqs: [0], shadowedTokenCount: 10 } })
  feed(local, { seq: 3, type: 'compaction/end', data: { compactionId: 'A' } })
  feed(local, { seq: 4, type: 'compaction/summary', data: { compactionId: 'B', shadowedSeqs: [1], shadowedTokenCount: 20 } })
  feed(local, { seq: 5, type: 'compaction/end', data: { compactionId: 'B' } })
  const queued = localAnchor.takePending(local)
  check('two compactions in one step are both queued', queued.length === 2 && queued.map((e) => e.id).join(',') === 'A,B', JSON.stringify(queued.map((e) => e.id)))

  feed(local, { seq: 6, type: 'compaction/prune', data: { shadowedSeqs: [7], shadowedTokenCount: 30 } })
  const pruned = localAnchor.takePending(local)
  check('a prune is announced too', pruned.length === 1 && pruned[0].id === 'prune:6', JSON.stringify(pruned.map((e) => e.id)))
  check('latestShadowSeq tracks the newest shadowing event', localAnchor.latestShadowSeq(local) === 6, localAnchor.latestShadowSeq(local))
  check('a prune span is still addressable', localAnchor.get(local, 'prune:6')?.shadowedSeqs.join(',') === '7')
}

console.log('config and boot:')
{
  let schemaOk = true
  let unknownOk = true
  try {
    Config({})
  } catch {
    schemaOk = false
  }
  try {
    Config({ somethingFromAnotherVersion: true })
  } catch {
    unknownOk = false
  }
  check('the config schema accepts an empty config', schemaOk)
  check('an unknown config key does not fail the schema (rollback safety)', unknownOk)

  const registered = []
  const bootCtx = { tools: { register: (tool) => registered.push(tool) }, on: () => {} }
  let bootOk = true
  try {
    apply(bootCtx, {})
  } catch (error) {
    bootOk = false
    console.log(`       boot error: ${error && error.message}`)
  }
  check('apply() registers the tools and boots', bootOk && registered.length === 5, `registered=${registered.length} (2 base + 3 memory in v1.3.0; workspace tools defer to sessionQuery)`)
}

console.log('notice source (Session format V4):')
{
  // The two spellings the plugin must recognise: what V4 writes now, and the
  // legacy wrapper still present in sessions being read at V3.
  check('recognises the named-producer kind it writes', isOwnSource({ kind: PRODUCER_KIND }))
  check('recognises the legacy { kind: "plugin" } wrapper', isOwnSource({ kind: 'plugin', plugin: PLUGIN_ID }))
  check("ignores another plugin's notice", !isOwnSource({ kind: 'plugin', plugin: 'dsh-run-watchdog' }))
  check('ignores a user-authored message', !isOwnSource({ kind: 'user' }))
  check('ignores a missing source', !isOwnSource(undefined))

  // Drive the REAL emission path: boot apply(), queue a compaction through the
  // session feed, then run the pre-step hook that appends the notice.
  const emitEvents = [
    { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { seq: 1, type: 'compaction/start', data: { compactionId: 'cmp-emit', turn: 1 } },
    { seq: 2, type: 'compaction/summary', data: { compactionId: 'cmp-emit', summary: [{ type: 'text', text: 's' }], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 10 } },
    { seq: 3, type: 'compaction/end', data: { compactionId: 'cmp-emit', turn: 1 } },
  ]
  const emitSession = makeSession(emitEvents)
  // `createAnchor` and `apply` BOTH subscribe to `session/event`, so handlers must be
  // collected per event rather than overwritten in a single-slot map.
  const bootHandlers = new Map()
  const ctx = {
    tools: { register: () => {} },
    on: (event, handler) => {
      if (!bootHandlers.has(event)) bootHandlers.set(event, [])
      bootHandlers.get(event).push(handler)
    },
  }
  apply(ctx, CONFIG)
  const fire = (event, ...args) => bootHandlers.get(event).map((handler) => handler(...args))

  fire('session/event', emitSession, emitEvents[3])
  const preStep = bootHandlers.get('agent/pre-step')
  // v1.3.0 mounts TWO pre-step hooks: onboard (resume offer) and the notice
  // poster. The emit session has no header.cwd, so onboard stays silent and
  // the notice path below behaves exactly as before.
  check('apply() subscribed to agent/pre-step', preStep?.length === 2, `handlers=${preStep?.length}`)
  // Chain the hooks the way cordis does: each hook's next() runs the rest of
  // the chain; the innermost next yields the base decision.
  let hookIndex = 0
  const runChain = async () => {
    if (hookIndex >= preStep.length) return { messages: [] }
    const hook = preStep[hookIndex]
    hookIndex += 1
    return hook({ agent: { session: emitSession } }, runChain)
  }
  const emitted = await runChain()
  const notice = emitted?.messages?.[emitted.messages.length - 1]
  check('the pre-step hook appends exactly one notice', emitted?.messages?.length === 1, `messages=${emitted?.messages?.length}`)
  check('the emitted notice carries the named-producer kind', notice?.source?.kind === PRODUCER_KIND, notice?.source?.kind)
  check('the emitted notice still declares notice form + summary', notice?.source?.form === 'notice' && typeof notice?.source?.summary === 'string')

  // Now the decisive check: hand the emitted message to the harness's OWN V4
  // admission rule. On a pre-0.1.7 harness that package does not exist (V4 did
  // not exist), so the check is skipped rather than failed.
  let assertV4RowAdmission
  try {
    ({ assertV4RowAdmission } = await import('@deepseek-ai/dsh-session-format-v3-to-v4'))
  } catch {
    assertV4RowAdmission = undefined
  }
  if (assertV4RowAdmission === undefined) {
    console.log('  skip harness V4 admission checks (pre-0.1.7 runtime)')
  } else {
    const row = (source) => ({ type: 'user/message', seq: 99, data: { ...notice, source } })
    let accepted = true
    let why = ''
    try {
      assertV4RowAdmission(row(notice.source))
    } catch (error) {
      accepted = false
      why = error.message
    }
    check('the harness V4 admission accepts the notice we emit', accepted, why)

    let refused = false
    try {
      assertV4RowAdmission(row({ kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'x' }))
    } catch {
      refused = true
    }
    check('the retired { kind: "plugin" } wrapper is refused (the 0.1.7 break)', refused)
  }
}

console.log('v1.1.2 regression batch:')
{
  // R: a regex search over an event longer than regexInputChars must REPORT
  // the part it never searched — "No matches" must never mean "I stopped
  // looking".
  const big = 'q'.repeat(300) + ' REGEX-NEEDLE ' + 'z'.repeat(300)
  const local = makeSession([{ seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: big }] } }])
  const localAnchor = createAnchor({ on: () => {} })
  const [localSearch] = createTools({ ...config, regexInputChars: 100 }, localAnchor)
  const localExec = { agent: { session: local } }
  const miss = await localSearch.execute({ query: 'REGEX-NEEDLE', regex: true }, localExec)
  check('a regex-window miss is counted, not silent', miss.hits.length === 0 && miss.clippedEvents === 1 && miss.clippedChars > 0, `hits=${miss.hits.length} clipped=${miss.clippedEvents}/${miss.clippedChars}`)
  const missRendered = localSearch.output.render({}, miss)[0].text
  check('the rendered output admits characters were NOT searched', missRendered.includes('NOT searched'), missRendered.slice(0, 200))

  const hit = await localSearch.execute({ query: 'REGEX-NEEDLE', regex: true, }, { agent: { session: local } })
  check('a regex hit inside the window still lands', (await createTools(config, localAnchor)[0].execute({ query: 'REGEX-NEEDLE', regex: true }, localExec)).hits.length === 1)
  check('a partially searched event counts once even under two caps', hit.clippedEvents <= 1, `clippedEvents=${hit.clippedEvents}`)

  // R: control events inside a recall span reconcile the accounting.
  const mixed = makeSession([
    { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'real text' }] } },
    { seq: 1, type: 'request/header', data: { model: 'x' } },
    { seq: 2, type: 'step/start', data: {} },
  ])
  const mixedAnchor = createAnchor({ on: () => {} })
  const [, mixedRecall] = createTools(config, mixedAnchor)
  const mixedOut = await mixedRecall.execute({ fromSeq: 0, toSeq: 2 }, { agent: { session: mixed } })
  check('control events are reported as carrying no restorable text', mixedOut.text.includes('no restorable text'), mixedOut.text.slice(-240))

  // R: duplicate seqs collapse instead of rendering twice.
  const dupOut = await mixedRecall.execute({ seqs: [0, 0, 0] }, { agent: { session: makeSession([
    { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'single-copy-text' }] } },
  ]) } })
  check('duplicate seqs render once, not three times', (dupOut.text.match(/single-copy-text/g) || []).length === 1, `occurrences=${(dupOut.text.match(/single-copy-text/g) || []).length}`)

  // R: a substring hit after a length-changing lowercase char keeps its window.
  const driftText = 'İİİİİ DRIFT-NEEDLE here'
  const drift = makeSession([{ seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: driftText }] } }])
  const driftAnchor = createAnchor({ on: () => {} })
  const [driftSearch] = createTools(config, driftAnchor)
  const driftHit = await driftSearch.execute({ query: 'drift-needle' }, { agent: { session: drift } })
  check('the snippet window survives lowercase length drift', driftHit.hits.length === 1 && driftHit.hits[0].snippet.includes('DRIFT-NEEDLE'), driftHit.hits[0]?.snippet)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
