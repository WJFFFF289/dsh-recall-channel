/**
 * The anchor: which spans of history were shadowed by compaction, and where the
 * original events still live.
 *
 * Nothing is persisted. The durable session log already records every
 * compaction (`compaction/start|summary|end|prune`), and `compaction/summary`
 * carries the authoritative `shadowedSeqs`. The index is therefore a *projection*
 * of the log, rebuilt by folding it — the same stance as VCC, which stores
 * nothing and computes views on demand.
 *
 * Note: `shadowedRange` is a surface-POSITION span, not a numeric interval — a
 * later replacement can land a fresh summary node at an older position, making
 * `start` greater than `end`. `shadowedSeqs` is the authoritative set.
 *
 * @module dsh-recall-channel/anchor
 */

/** @returns {Map<string, object>} the per-session compaction index. */
function foldLog(session, map) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return map
  }
  for (const event of events) {
    const type = event && event.type
    if (typeof type === 'string' && type.startsWith('compaction/')) absorb(map, event)
  }
  return map
}

function absorb(map, event) {
  const data = (event && event.data) || {}
  if (event.type === 'compaction/summary') {
    const id = String(data.compactionId)
    const previous = map.get(id) || { id, kind: 'compaction' }
    // `shadowedSeqs` is the authoritative set of shadowed surface nodes.
    map.set(id, {
      ...previous,
      kind: 'compaction',
      summarySeq: event.seq,
      shadowedSeqs: [...(data.shadowedSeqs || [])],
      shadowedRange: data.shadowedRange,
      shadowedTokenCount: data.shadowedTokenCount || 0,
      provider: data.provider,
      model: data.model,
    })
    return
  }
  if (event.type === 'compaction/end') {
    const id = String(data.compactionId)
    const previous = map.get(id) || { id, kind: 'compaction', shadowedSeqs: [], shadowedTokenCount: 0 }
    map.set(id, { ...previous, endSeq: event.seq, failed: data.error !== undefined })
    return
  }
  if (event.type === 'compaction/prune') {
    // A model-free prune has no compaction id; key it by its own event seq.
    const id = `prune:${event.seq}`
    map.set(id, {
      id,
      kind: 'prune',
      pruneSeq: event.seq,
      shadowedSeqs: [...(data.shadowedSeqs || [])],
      shadowedRange: data.shadowedRange,
      shadowedTokenCount: data.shadowedTokenCount || 0,
    })
  }
}

/**
 * Build the anchor service.
 * @param ctx - plugin context (used only for the append feed).
 * @returns `{ list(session), get(session, id), shadowedSeqSet(session), pendingNotice(session) }`.
 */
export function createAnchor(ctx) {
  const perSession = new WeakMap()
  const pending = new WeakMap()

  function ensure(session) {
    let map = perSession.get(session)
    if (map) return map
    map = new Map()
    perSession.set(session, map)
    // The plugin may be installed mid-life: fold the existing log so compactions
    // that happened before it loaded are still addressable.
    return foldLog(session, map)
  }

  ctx.on('session/event', (session, event) => {
    const type = event && event.type
    if (typeof type !== 'string' || !type.startsWith('compaction/')) return
    absorb(ensure(session), event)
    if (type === 'compaction/end' && !event.data.error) {
      const id = String(event.data.compactionId)
      const entry = ensure(session).get(id)
      if (entry && entry.shadowedSeqs.length > 0) pending.set(session, entry)
    }
  })

  return {
    /** All known compactions, newest first. */
    list(session) {
      return [...ensure(session).values()].sort((a, b) =>
        ((b.summarySeq ?? b.pruneSeq) || 0) - ((a.summarySeq ?? a.pruneSeq) || 0))
    },
    /** One compaction by id. */
    get(session, id) {
      return ensure(session).get(String(id))
    },
    /** Flat set of every shadowed seq across all compactions. */
    shadowedSeqSet(session) {
      const set = new Set()
      for (const entry of ensure(session).values()) for (const seq of entry.shadowedSeqs) set.add(seq)
      return set
    },
    /** Consume the one-shot post-compaction notice, if any. */
    takePending(session) {
      const entry = pending.get(session)
      if (entry) pending.delete(session)
      return entry
    },
  }
}
