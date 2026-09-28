/**
 * Text metrics: token estimation, byte accounting, code-point-safe slicing.
 *
 * The harness's own estimator is a flat `chars / 4`. That is right for ASCII and
 * wrong for CJK by roughly 3x — one Chinese character is about one token, not a
 * quarter of one. A flat divisor would silently hand a Chinese conversation
 * three times the intended budget and then report a third of what it delivered.
 * Weigh CJK code points instead; for ASCII the result is identical to before.
 *
 * @module dsh-recall-channel/metrics
 */

/**
 * Code points that tokenize near 1 token per character: CJK ideographs, kana,
 * hangul, CJK compat/fullwidth forms, CJK punctuation.
 */
const CJK = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

/** Anything outside 7-bit ASCII needs the per-character walk. */
const NON_ASCII = /[^\u0000-\u007f]/

/** Codepoints per token for the non-CJK range (the harness's chars/4 density). */
const ASCII_TOKENS_PER_CHAR = 0.25

/**
 * Estimate tokens for budgeting and reporting.
 * @param text - any text.
 * @returns a positive integer token estimate (0 for empty input).
 */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (s.length === 0) return 0
  if (!NON_ASCII.test(s)) return Math.max(1, Math.ceil(s.length * ASCII_TOKENS_PER_CHAR))
  let units = 0
  for (const ch of s) units += CJK.test(ch) ? 1 : ASCII_TOKENS_PER_CHAR
  return Math.max(1, Math.ceil(units))
}

/**
 * UTF-8 byte length, the unit `TextRetainer` budgets in.
 * @param text - any text.
 * @returns byte count.
 */
export function byteLength(text) {
  return Buffer.byteLength(typeof text === 'string' ? text : String(text ?? ''), 'utf8')
}

const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff
const LOW_SURROGATE_FIRST = 0xdc00
const LOW_SURROGATE_LAST = 0xdfff

/**
 * Whether a UTF-16 code unit is a high surrogate (first half of a pair).
 * @param code - `charCodeAt` result.
 */
function isHigh(code) {
  return code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST
}

/**
 * Whether a UTF-16 code unit is a low surrogate (second half of a pair).
 * @param code - `charCodeAt` result.
 */
function isLow(code) {
  return code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST
}

/**
 * Clip to at most `max` UTF-16 units without stranding half a surrogate pair.
 * `String.slice` can cut between the halves of an astral character, which the
 * encoder then turns into U+FFFD; this never does.
 *
 * @param text - source text.
 * @param max - maximum UTF-16 units to keep.
 * @returns `{ text, dropped }` with `dropped` in UTF-16 units.
 */
export function clipAtCodePoint(text, max) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(max) || max <= 0) return { text: '', dropped: s.length }
  if (s.length <= max) return { text: s, dropped: 0 }
  let kept = s.slice(0, max)
  if (isHigh(kept.charCodeAt(kept.length - 1))) kept = kept.slice(0, -1)
  return { text: kept, dropped: s.length - kept.length }
}

/**
 * Window of text around one match, with ellipses showing what was cut. Both
 * boundaries are pulled back to code-point edges.
 *
 * @param text - full searchable text.
 * @param index - match offset (UTF-16 units).
 * @param width - approximate snippet width in characters.
 * @returns snippet string.
 */
export function windowAround(text, index, width) {
  const s = typeof text === 'string' ? text : ''
  const half = Math.max(20, Math.floor(width / 2))
  let start = Math.max(0, index - half)
  let end = Math.min(s.length, index + half)
  if (start > 0 && isLow(s.charCodeAt(start))) start -= 1
  if (end < s.length && end > 0 && isHigh(s.charCodeAt(end - 1))) end -= 1
  const head = start > 0 ? '…' : ''
  const tail = end < s.length ? '…' : ''
  return head + s.slice(start, end).replace(/\s+/g, ' ').trim() + tail
}

/**
 * Map a match offset found in `text.toLowerCase()` back to the original
 * string. Lowercasing can change code-unit length (e.g. `İ` → `i̇` is one
 * code unit becoming two), so an offset in the lowercased copy is not always
 * the offset in the original — a snippet taken at the raw offset drifts by
 * however many units the expansions added before it. Walks code points and
 * costs O(index), paid once per hit (hits are capped by the search limit).
 *
 * @param text - the ORIGINAL text.
 * @param lowercasedIndex - match offset inside `text.toLowerCase()`.
 * @returns the matching offset inside the original text.
 */
export function originalIndexOfLowercased(text, lowercasedIndex) {
  const s = typeof text === 'string' ? text : ''
  if (!Number.isFinite(lowercasedIndex) || lowercasedIndex <= 0) return 0
  let lc = 0
  let original = 0
  for (const ch of s) {
    if (lc >= lowercasedIndex) return original
    lc += ch.toLowerCase().length
    original += ch.length
  }
  return s.length
}
