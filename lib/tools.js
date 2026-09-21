/**
 * The two model-facing tools: locate, then restore.
 *
 * `search_history` answers "where in this conversation did we talk about X?"
 * and returns coordinates. `recall_history` turns coordinates back into the
 * original text. The split mirrors the search / describe / expand triad used by
 * OpenClaw's LCM plugin and dsh-compaction-instant's recall + search pair.
 *
 * Budget rules follow lossless-code: take whole content, never truncate
 * silently, and always tell the model what was withheld.
 *
 * @module dsh-recall-channel/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { eventPlainText, eventRole, renderEvent, snippetAround } from './render.js'

/** Rough token estimate; matches the harness estimator's chars/4 density. */
const CHARS_PER_TOKEN = 4

function tokensOf(text) {
  return Math.ceil(String(text).length / CHARS_PER_TOKEN)
}

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

/** Per-session recall ledger: what was already restored, and how much. */
function createLedger() {
  const perSession = new WeakMap()
  return function ledgerFor(session) {
    let state = perSession.get(session)
    if (!state) {
      state = { recalledSeqs: new Set(), recalledTokens: 0 }
      perSession.set(session, state)
    }
    return state
  }
}

/**
 * Build both tool definitions.
 * @param config - resolved plugin config.
 * @param anchor - the compaction anchor.
 * @returns array of tool definitions for `ctx.tools.register`.
 */
export function createTools(config, anchor) {
  const ledgerFor = createLedger()

  const searchHistory = defineTool({
    name: 'search_history',
    description: [
      'Search this conversation\'s durable history, INCLUDING the parts that were removed from your',
      'visible context by compaction. Use it before answering anything that depends on earlier',
      'details — exact file paths, error strings, numbers, identifiers, decisions, "what did we',
      'decide about X". Matches return their `seq` coordinate (and the owning compaction id when the',
      'match lives in shadowed history); feed that to `recall_history` to read the original text.',
      'Prefer this over guessing or over re-deriving work that was already done.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Text to look for (case-insensitive substring by default).' },
      regex: { type: 'boolean', description: 'Treat `query` as a JavaScript regular expression.' },
      scope: { type: 'string', enum: ['all', 'shadowed'], description: 'all (default) searches the entire log; shadowed searches only content hidden by compaction.' },
      limit: { type: 'integer', description: 'Maximum number of matches to return.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                role: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                compactionId: { type: 'string' },
                shadowed: { type: 'boolean' },
              },
            },
          },
          scanned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          compactions: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.hits.length === 0) {
          lines.push('No matches in the conversation history.')
        } else {
          lines.push(`${value.hits.length} match(es)${value.truncated ? ' (limit reached)' : ''}:`)
          for (const hit of value.hits) {
            lines.push(`- seq ${hit.seq} [${hit.role}]${hit.shadowed ? ` (shadowed by ${hit.compactionId})` : ''}: ${hit.snippet}`)
          }
          lines.push('Call recall_history with the compactionId (or explicit seqs) to read the original text verbatim.')
        }
        if (value.compactions > 0) lines.push(`(${value.compactions} compaction(s) recorded in this session.)`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const session = exec && exec.agent && exec.agent.session
      if (!session) throw new Error('search_history requires an owning agent session')
      const limit = clamp(args.limit, 1, 100, config.searchLimit)
      const scope = args.scope === 'shadowed' ? 'shadowed' : 'all'
      const shadowedSet = scope === 'shadowed' ? anchor.shadowedSeqSet(session) : null
      const ownerOf = new Map()
      for (const entry of anchor.list(session)) for (const seq of entry.shadowedSeqs) ownerOf.set(seq, entry.id)

      const query = String(args.query ?? '')
      if (query.length === 0) throw new Error('search_history requires a non-empty query')
      let matcher = null
      if (args.regex === true) {
        try {
          matcher = new RegExp(query, 'i')
        } catch (error) {
          throw new Error(`search_history: invalid regular expression: ${error && error.message}`)
        }
      }
      const needle = query.toLowerCase()

      const hits = []
      let scanned = 0
      for (const event of session.snapshotEvents()) {
        if (shadowedSet && !shadowedSet.has(event.seq)) continue
        const text = eventPlainText(event, config)
        if (!text) continue
        if (++scanned > config.scanLimit) break
        const index = matcher ? text.search(matcher) : text.toLowerCase().indexOf(needle)
        if (index < 0) continue
        const owner = ownerOf.get(event.seq)
        hits.push({
          seq: event.seq,
          role: eventRole(event),
          snippet: snippetAround(text, index, config.snippetChars),
          ...(owner ? { compactionId: owner, shadowed: true } : {}),
        })
        if (hits.length >= limit) break
      }

      return Promise.resolve({
        hits,
        scanned,
        truncated: hits.length >= limit,
        compactions: anchor.list(session).length,
      })
    },
    presentCall: (args) => ({ card: 'generic', title: 'Search conversation history', kind: 'read', rawInput: args.query }),
  })

  const recallHistory = defineTool({
    name: 'recall_history',
    description: [
      'Restore original conversation text that is no longer visible — typically content that',
      'compaction shadowed. Give it a `compactionId` (from search_history) to restore that whole',
      'shadowed span, or explicit `seqs` / a `fromSeq`+`toSeq` range. The text returned is the',
      'durable log content, not a summary. A token budget applies; when the span does not fit you',
      'get the beginning and the end plus an exact note of what was withheld, and you can page',
      'through the rest with narrower ranges. Only the requested span is read back, so this',
      'remains cheap compared with carrying the whole history.',
    ].join(' '),
    parameters: {
      compactionId: { type: 'string', description: 'Restore every event shadowed by this compaction.' },
      seqs: { type: 'array', items: { type: 'integer' }, description: 'Explicit event sequence numbers to restore, in order.' },
      fromSeq: { type: 'integer', description: 'Start of an inclusive seq range (use with toSeq).' },
      toSeq: { type: 'integer', description: 'End of an inclusive seq range (use with fromSeq).' },
      budgetTokens: { type: 'integer', description: 'Approximate token budget for this call.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          returnedTokens: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          omittedSeqs: { type: 'array', required: true, items: { type: 'integer' } },
          label: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const session = exec && exec.agent && exec.agent.session
      if (!session) throw new Error('recall_history requires an owning agent session')

      let seqs = []
      let label = ''
      if (typeof args.compactionId === 'string' && args.compactionId.length > 0) {
        const entry = anchor.get(session, args.compactionId)
        if (!entry) {
          const known = anchor.list(session).map((e) => e.id).join(', ') || '(none)'
          throw new Error(`recall_history: unknown compactionId "${args.compactionId}"; known: ${known}`)
        }
        seqs = entry.shadowedSeqs
        label = `compaction ${entry.id} (${entry.shadowedTokenCount} tokens shadowed)`
      } else if (Array.isArray(args.seqs) && args.seqs.length > 0) {
        seqs = args.seqs
        label = `seqs ${seqs[0]}–${seqs[seqs.length - 1]}`
      } else if (Number.isInteger(args.fromSeq) && Number.isInteger(args.toSeq)) {
        const from = Math.min(args.fromSeq, args.toSeq)
        const to = Math.max(args.fromSeq, args.toSeq)
        seqs = []
        for (let seq = from; seq <= to; seq++) seqs.push(seq)
        label = `seqs ${from}–${to}`
      } else {
        throw new Error('recall_history requires compactionId, seqs, or fromSeq+toSeq')
      }
      if (seqs.length === 0) {
        return Promise.resolve({ text: `[recall] ${label}: nothing recorded for that span.`, returnedTokens: 0, truncated: false, omittedSeqs: [], label })
      }

      const ledger = ledgerFor(session)
      const fresh = seqs.filter((seq) => !ledger.recalledSeqs.has(seq))
      if (fresh.length === 0) {
        return Promise.resolve({
          text: `[recall] ${label}: these ${seqs.length} event(s) were already restored earlier in this conversation; re-read that tool result instead of pulling them in again.`,
          returnedTokens: 0,
          truncated: false,
          omittedSeqs: seqs,
          label,
        })
      }

      const budgetTokens = clamp(args.budgetTokens, 256, config.maxRecallTokens, config.maxRecallTokens)
      const remainingSessionTokens = Math.max(0, config.maxSessionRecallTokens - ledger.recalledTokens)
      const effectiveTokens = Math.min(budgetTokens, remainingSessionTokens)

      const parts = []
      const missing = []
      for (const seq of fresh) {
        let event
        try {
          event = session.eventAt(seq)
        } catch {
          event = undefined
        }
        if (!event) {
          missing.push(seq)
          continue
        }
        const rendered = renderEvent(event, config)
        if (rendered) parts.push(`--- seq ${seq} ---\n${rendered}`)
      }

      const full = parts.join('\n\n')
      const headBytes = Math.floor(effectiveTokens * CHARS_PER_TOKEN * 0.6)
      const tailBytes = Math.floor(effectiveTokens * CHARS_PER_TOKEN * 0.3)
      let text = full
      let truncated = false
      if (effectiveTokens <= 0) {
        text = ''
        truncated = parts.length > 0
      } else {
        const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes })
        retainer.push(full)
        const retained = retainer.finish()
        text = retained.text
        truncated = retained.truncated
      }

      const notes = [`[recall] ${label}: restored ${parts.length} event(s), ~${tokensOf(text)} tokens.`]
      if (truncated) notes.push('The middle of the span was withheld to stay inside the budget — call recall_history again with a narrower fromSeq/toSeq range to read it.')
      if (missing.length > 0) notes.push(`Not addressable (no such event): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` …(+${missing.length - 20})` : ''}`)
      if (effectiveTokens < budgetTokens) notes.push(`Session recall budget nearly exhausted (${ledger.recalledTokens}/${config.maxSessionRecallTokens} tokens already restored); this call was capped at ~${effectiveTokens} tokens.`)

      const returnedTokens = tokensOf(text)
      for (const seq of fresh) ledger.recalledSeqs.add(seq)
      ledger.recalledTokens += returnedTokens

      return Promise.resolve({
        text: `${text ? `${text}\n\n` : ''}${notes.join('\n')}`,
        returnedTokens,
        truncated,
        omittedSeqs: truncated ? fresh : [],
        label,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Restore compacted history',
      kind: 'read',
      rawInput: args.compactionId ?? args.seqs ?? `${args.fromSeq}–${args.toSeq}`,
    }),
  })

  return [searchHistory, recallHistory]
}
