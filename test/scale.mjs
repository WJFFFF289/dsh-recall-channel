/**
 * Scale check: the search projection changed in v1.1 (the per-block display cap
 * no longer applies, so every event is fully rendered for matching). This
 * measures the real cost on a synthetic log of the same shape as the reference
 * session, plus the worst case (no match, so nothing short-circuits).
 *
 * Run: node test/scale.mjs
 */
import { createAnchor } from '../lib/anchor.js'
import { createTools } from '../lib/tools.js'

const CONFIG = {
  enabled: true, searchLimit: 20, snippetChars: 240, scanLimit: 200000,
  maxRecallTokens: 16000, maxSessionRecallTokens: 64000, blockChars: 0, argChars: 0,
  searchTextChars: 200000, maxRangeSeqs: 200000, allowRegex: true, regexMaxPatternChars: 200,
  regexInputChars: 20000, regexBudgetMs: 250, includeReasoning: false, hintOnCompaction: true,
  notifyOnPrune: true, noticeRefresh: true, wrapRecalledText: true,
}

function build(count, charsEach) {
  const events = []
  for (let index = 0; index < count; index += 1) {
    const body = `row ${index} ` + 'x'.repeat(Math.max(0, charsEach - 12))
    events.push({ seq: index, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: body }] } })
  }
  events.push({ seq: count, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'the needle TAILNEEDLE lives here' }] } })
  return events
}

const anchor = createAnchor({ on: () => {} })
for (const [count, chars] of [[5800, 3600], [50000, 2000], [200000, 2000]]) {
  const events = build(count, chars)
  const session = { id: 's', seq: events.length, snapshotEvents: () => events, eventAt: (seq) => events[seq] }
  const [search] = createTools(CONFIG, anchor)
  const exec = { agent: { session } }

  global.gc?.()
  let t = Date.now()
  await search.execute({ query: 'no-such-needle-at-all' }, exec)
  const miss = Date.now() - t
  t = Date.now()
  const hit = await search.execute({ query: 'TAILNEEDLE' }, exec)
  const tail = Date.now() - t
  t = Date.now()
  await search.execute({ query: 'row 5', limit: 100 }, exec)
  const hitFirst = Date.now() - t

  const bytes = events.reduce((sum, event) => sum + (event.data.content?.[0]?.text?.length ?? 0), 0)
  console.log(`${String(count).padStart(7)} events / ${(bytes / 1048576).toFixed(1).padStart(6)} MB text  |  miss ${String(miss).padStart(4)}ms  first ${String(hitFirst).padStart(3)}ms  tail ${String(tail).padStart(4)}ms (hits=${hit.hits.length}, scanned=${hit.scanned})`)
}
