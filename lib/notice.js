/**
 * The notices this plugin posts, and the rule that keeps one of them alive.
 *
 * A notice is an ordinary appended `user/message`. That is the honest way to
 * inject guidance — it mutates nothing — but it also means the next compaction
 * treats the notice as ordinary history and shadows it: of the eight notices in
 * the reference session, four were eaten by the following compaction. The
 * retrieval ability never depended on them (the tools are always registered);
 * what dies is the model's awareness that it should use them.
 *
 * We cannot write the guidance into the compaction summary itself — that would
 * mean replacing or rewriting the summarizer, which this plugin deliberately
 * does not do — so instead the guidance is re-posted: whenever the standing
 * notice has been shadowed by a newer compaction or prune, one terse reminder
 * is appended. At most one notice per shadowing event, so it cannot
 * self-amplify.
 *
 * @module dsh-recall-channel/notice
 */

/** Plugin id used both in the message source and to recognise our own notices. */
export const PLUGIN_ID = 'dsh-recall-channel'

/** One line describing what was shadowed and how to get it back. */
function entryLine(entry) {
  const count = entry.shadowedSeqs.length
  const tokens = entry.shadowedTokenCount
  const what = entry.kind === 'prune' ? 'event(s) pruned from' : 'message(s) compacted out of'
  return `- ${count} ${what} your visible context (~${tokens} tokens) →  recall_history with compactionId "${entry.id}"`
}

/**
 * The full notice, for one or more shadowing events that happened together.
 * @param entries - anchor entries with a non-empty `shadowedSeqs`.
 * @returns message text.
 */
export function noticeText(entries) {
  const lines = [
    `[recall-channel] Part of your history just left the visible context (${entries.length} record(s)):`,
    ...entries.map(entryLine),
    'The originals are still in the durable session log, verbatim. Use search_history to locate a detail, then recall_history to read it.',
    'Do not reconstruct those details from the summary.',
  ]
  return lines.join('\n')
}

/**
 * The terse reminder posted when the standing notice has itself been shadowed.
 * @param entries - the shadowing records.
 * @returns message text.
 */
export function reminderText(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.shadowedSeqs.length, 0)
  return [
    `[recall-channel] Reminder: ${total} earlier message(s) are no longer in your visible context (compacted or pruned).`,
    'search_history locates a detail and returns its seq; recall_history reads the original text back verbatim.',
    'Prefer that over guessing or re-deriving work that was already done.',
  ].join(' ')
}

/**
 * Per-session bookkeeping for the refresh rule.
 * @returns tracker API; sessions are WeakMap keys, so nothing outlives a session.
 */
export function createNoticeTracker() {
  const perSession = new WeakMap()
  const stateOf = (session) => {
    let state = perSession.get(session)
    if (!state) {
      state = { lastNoticeSeq: -1, refreshedFor: -1 }
      perSession.set(session, state)
    }
    return state
  }
  return {
    /** Remember where our own notice landed in the log. */
    recordNotice(session, seq) {
      if (typeof seq === 'number' && Number.isFinite(seq)) stateOf(session).lastNoticeSeq = seq
    },
    /** @returns the recorded notice seq, or -1. */
    lastNoticeSeq(session) {
      return stateOf(session).lastNoticeSeq
    },
    /**
     * Decide whether the standing guidance needs re-posting.
     *
     * True only when: we posted a notice, that notice is now shadowed, and a
     * shadowing event newer than the last refresh caused it. The last clause is
     * what bounds the loop — each shadowing event can trigger at most one
     * reminder.
     *
     * @param session - the owning session.
     * @param facts - `{ shadowedSeqSet, latestShadowSeq }`.
     * @returns whether to post a reminder.
     */
    shouldRefresh(session, { shadowedSeqSet, latestShadowSeq }) {
      const state = stateOf(session)
      if (state.lastNoticeSeq < 0) return false
      if (!(shadowedSeqSet instanceof Set) || !shadowedSeqSet.has(state.lastNoticeSeq)) return false
      if (!(latestShadowSeq > state.lastNoticeSeq)) return false
      return latestShadowSeq > state.refreshedFor
    },
    /** Record that a reminder was posted for the current shadowing event. */
    markRefreshed(session, latestShadowSeq) {
      if (typeof latestShadowSeq === 'number' && Number.isFinite(latestShadowSeq)) stateOf(session).refreshedFor = latestShadowSeq
    },
  }
}
