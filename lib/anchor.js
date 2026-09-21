/**
 * The anchor: which spans of history were shadowed by compaction (or pruned),
 * and where the original events still live.
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

/**
 * Fail with something readable when the session cannot be read: either the tool
 * was called without an owning session, or this DSH build no longer offers the
 * synchronous event reads. Those reads are marked `@deprecated` upstream ("new
 * calls are prohibited") although the harness core still uses them everywhere;
 * if a future version removes them, the plugin must degrade with a message
 * instead of a bare TypeError deep inside a tool call.
 *
 * @param session - the owning agent session.
 * @param tool - the calling tool's name, for the message.
 * @returns the same session when it is readable.
 */
export function requireReadableSession(session, tool = 'dsh-recall-channel') {
  if (!session) throw new Error(`${tool} requires an owning agent session`)
  if (typeof session.snapshotEvents !== 'function' || typeof session.eventAt !== 'function') {
    throw new Error(`${tool}: this DSH build does not expose session.snapshotEvents()/session.eventAt(); the plugin needs an update for this harness version`)
  }
  return session
}

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

/**
 * Fold one `compaction/*` event into the index.
 * @param map - the per-session index.
 * @param event - a `compaction/*` session event.
 * @returns the entry this event belongs to, if any.
 */
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
    return map.get(id)
  }
  if (event.type === 'compaction/end') {
    const id = String(data.compactionId)
    const failed = data.error !== undefined
    const previous = map.get(id)
    // A failed compaction never produces a `compaction/summary`, so it shadowed
    // nothing and must not become an entry: it used to inflate the recorded
    // count (9 real compactions read as 17) and pollute the id list.
    if (!previous && failed) return undefined
    const entry = { ...(previous || { id, kind: 'compaction', shadowedSeqs: [], shadowedTokenCount: 0 }), endSeq: event.seq, failed }
    map.set(id, entry)
    return entry
  }
  if (event.type === 'compaction/prune') {
    // A model-free prune has no compaction id; key it by its own event seq.
    const id = `prune:${event.seq}`
    const entry = {
      id,
      kind: 'prune',
      pruneSeq: event.seq,
      shadowedSeqs: [...(data.shadowedSeqs || [])],
      shadowedRange: data.shadowedRange,
      shadowedTokenCount: data.shadowedTokenCount || 0,
    }
    map.set(id, entry)
    return entry
  }
  return undefined
}

/**
 * Build the anchor service.
 * @param ctx - plugin context (used only for the append feed).
 * @returns the anchor API.
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

  /**
   * Queue one notice. Two compactions can land inside a single agent step, and
   * the previous single-slot version silently dropped the earlier one.
   */
  function enqueue(session, entry) {
    const queue = pending.get(session) || []
    if (!queue.some((queued) => queued.id === entry.id)) queue.push(entry)
    pending.set(session, queue)
  }

  ctx.on('session/event', (session, event) => {
    const type = event && event.type
    if (typeof type !== 'string' || !type.startsWith('compaction/')) return
    const entry = absorb(ensure(session), event)
    if (!entry || entry.shadowedSeqs.length === 0) return
    // Both a compaction and a prune push content out of the visible surface;
    // both are still addressable, so both deserve a notice.
    if (type === 'compaction/end' || type === 'compaction/prune') enqueue(session, entry)
  })

  return {
    /** Every record that actually shadowed something, newest first. */
    list(session) {
      return [...ensure(session).values()]
        .filter((entry) => entry.shadowedSeqs.length > 0)
        .sort((a, b) => ((b.summarySeq ?? b.pruneSeq) || 0) - ((a.summarySeq ?? a.pruneSeq) || 0))
    },
    /** One compaction by id. */
    get(session, id) {
      return ensure(session).get(String(id))
    },
    /** Flat set of every shadowed seq across all compactions and prunes. */
    shadowedSeqSet(session) {
      const set = new Set()
      for (const entry of ensure(session).values()) for (const seq of entry.shadowedSeqs) set.add(seq)
      return set
    },
    /** Seq of the newest shadowing event (compaction summary or prune), or -1. */
    latestShadowSeq(session) {
      let latest = -1
      for (const entry of ensure(session).values()) {
        const at = entry.summarySeq ?? entry.pruneSeq
        if (typeof at === 'number' && at > latest) latest = at
      }
      return latest
    },
    /** Drain every notice queued since the last drain. */
    takePending(session) {
      const queue = pending.get(session)
      if (!queue || queue.length === 0) return []
      pending.delete(session)
      return queue
    },
  }
}
