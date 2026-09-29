/**
 * v1.3.0 tests: memory file, onboard resume offer, cross-session search.
 *
 * Memory ops run against a temp directory; onboard and workspace_search run
 * against mock contexts (the same fake-ctx pattern mechanics.mjs uses), so
 * everything here is hermetic — no harness data dir, no GUI, no model.
 *
 * Run: node test/onboard-memory.mjs
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { appendMemory, readMemory, deleteMemoryEntries, createMemoryTools, memoryPaths } from '../lib/memory.js'
import { registerOnboard } from '../lib/onboard.js'
import { createWorkspaceTools } from '../lib/workspace.js'
import { apply } from '../lib/index.js'

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok   ${label}`) }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ---- shared fakes ------------------------------------------------------------
function makeCtx(services = {}) {
  const handlers = new Map()
  const toolMap = new Map()
  toolMap.register = (tool) => toolMap.set(tool.name, tool)
  return {
    handlers,
    tools: toolMap,
    on: (event, fn) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    get: (name) => services[name],
  }
}

function makeSession(events, { cwd = 'C:/ws/test', id = 'session-caller' } = {}) {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  return {
    id,
    seq: events.length,
    header: { cwd, id, createdAt: Date.now() },
    snapshotEvents: () => events,
    eventAt: (seq) => bySeq.get(seq),
  }
}

const BASE_CONFIG = {
  enabled: true, searchLimit: 20, snippetChars: 240, scanLimit: 200000,
  maxRecallTokens: 16000, maxSessionRecallTokens: 64000, blockChars: 0, argChars: 0,
  searchTextChars: 200000, maxRangeSeqs: 200000, allowRegex: true,
  regexMaxPatternChars: 200, regexInputChars: 20000, regexBudgetMs: 250,
  includeReasoning: false, hintOnCompaction: true, notifyOnPrune: true,
  noticeRefresh: true, wrapRecalledText: true, workspaceSummaryChars: 500,
  onboardMode: 'ask', onboardMaxSessions: 5, onboardSummaryChars: 500,
  workspaceSearch: true, searchMaxSessions: 20,
  memoryEnabled: true, memoryFileMaxChars: 8000, memoryConfirmWrite: false,
}

const userMsg = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })
const assistantMsg = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

// ==============================================================================
console.log('memory file ops:')
{
  const tmp = mkdtempSync(join(tmpdir(), 'rc-mem-'))

  const r1 = await appendMemory({ cwd: tmp, sessionId: 'session-aaaabbbb', content: '登录超时的根因是 token 刷新竞态', maxChars: 8000 })
  check('first append creates the file', existsSync(memoryPaths(tmp).main))
  check('first append returns the stamped line', r1.line.includes('登录超时') && r1.line.includes('aaaabb'), r1.line)
  check('first append counts one entry', r1.totalEntries === 1, `entries=${r1.totalEntries}`)

  const r2 = await appendMemory({ cwd: tmp, sessionId: 'session-ccccdddd', content: '第一行\n第二行\n\n第三行', maxChars: 8000 })
  check('newlines collapse into one line', !r2.line.slice(r2.line.indexOf(']') + 1).includes('\n'), JSON.stringify(r2.line))

  const longContent = 'x'.repeat(600)
  const r3 = await appendMemory({ cwd: tmp, sessionId: 'session-eeeeffff', content: longContent, maxChars: 8000 })
  check('entries cap at 500 chars', r3.line.length <= 560, `len=${r3.line.length}`)

  let threw = false
  try { await appendMemory({ cwd: tmp, sessionId: 'session-z', content: '   ', maxChars: 8000 }) } catch { threw = true }
  check('empty content is refused', threw)

  const read1 = await readMemory({ cwd: tmp })
  check('readMemory returns all entries with numbers', read1.entries.length === 3 && read1.entries[0].n === 1, `entries=${read1.entries.length}`)

  // Roll-over: tiny budget forces the oldest half into the archive.
  const tmp2 = mkdtempSync(join(tmpdir(), 'rc-mem-roll-'))
  for (let i = 0; i < 10; i += 1) {
    await appendMemory({ cwd: tmp2, sessionId: 'session-roll', content: `第 ${i} 条记忆，内容填充填充填充填充填充`, maxChars: 260 })
  }
  const read2 = await readMemory({ cwd: tmp2 })
  check('overflow rolls old entries out of the main file', read2.entries.length < 10, `main=${read2.entries.length}`)
  check('overflow lands them in the archive', existsSync(memoryPaths(tmp2).archive) && readFileSync(memoryPaths(tmp2).archive, 'utf8').includes('第 0 条'))

  const del = await deleteMemoryEntries({ cwd: tmp, numbers: [2] })
  check('delete removes exactly the numbered entry', del.removed.length === 1 && del.removed[0].includes('ccccdd'), del.removed[0])
  const read3 = await readMemory({ cwd: tmp })
  check('delete keeps the other entries', read3.entries.length === 2, `entries=${read3.entries.length}`)

  let delThrew = false
  try { await deleteMemoryEntries({ cwd: tmp, numbers: [99] }) } catch { delThrew = true }
  check('deleting a missing number is a readable error', delThrew)

  rmSync(tmp, { recursive: true, force: true })
  rmSync(tmp2, { recursive: true, force: true })
}

// ==============================================================================
console.log('memory tools (via apply):')
{
  const tmp = mkdtempSync(join(tmpdir(), 'rc-memtool-'))
  const ctx = makeCtx()
  apply(ctx, { ...BASE_CONFIG })
  const remember = ctx.tools.get('workspace_remember')
  const memory = ctx.tools.get('workspace_memory')
  const forget = ctx.tools.get('workspace_forget')
  check('memory tools register without sessionQuery', Boolean(remember && memory && forget))

  const session = makeSession([], { cwd: tmp })
  const exec = { agent: { session } }
  const w = await remember.execute({ content: '决定：回测框架用 vectorbt' }, exec)
  check('remember writes and reports', w.totalEntries === 1 && w.confirmed === true, JSON.stringify(w))

  const r = await memory.execute({}, exec)
  check('memory reads the line back', r.entries.length === 1 && r.entries[0].line.includes('vectorbt'))

  const q = await forget.execute({ query: 'vectorbt' }, exec)
  check('forget query lists candidates without deleting', q.matches.length === 1 && q.removed === undefined)

  const d = await forget.execute({ lines: [q.matches[0].n] }, exec)
  check('forget lines deletes', d.removed.length === 1 && d.remaining === 0)

  // confirm-write: refusal must not write.
  const ctx2 = makeCtx({
    userQuestions: {
      ask: async () => ({ answers: [{ id: 'memory-confirm', selected: ['不写入'] }] }),
    },
  })
  apply(ctx2, { ...BASE_CONFIG, memoryConfirmWrite: true })
  const w2 = await ctx2.tools.get('workspace_remember').execute({ content: '不该写入的' }, { agent: { session: makeSession([], { cwd: tmp }) } })
  check('confirm-write refusal does not write', w2.confirmed === false && w2.totalEntries === -1)
  const r2 = await memory.execute({}, exec)
  check('refused memory is absent from the file', r2.entries.length === 0)

  rmSync(tmp, { recursive: true, force: true })
}

// ==============================================================================
console.log('onboard:')
{
  const mkSQ = (others) => ({
    filterSessions: async () => others,
    readTitle: async () => ({ title: '旧会话标题' }),
    readSession: async () => ({ events: [] }),
  })
  const otherRecs = [
    { header: { id: 'session-old-1', cwd: 'C:/ws/test', createdAt: Date.parse('2026-09-28T02:00:00Z') }, live: false },
    { header: { id: 'session-old-2', cwd: 'C:/ws/test', createdAt: Date.parse('2026-09-27T02:00:00Z') }, live: false },
  ]
  const freshSession = () => makeSession([userMsg(0, '你好')], { cwd: 'C:/ws/test' })
  const firePreStep = async (ctx, session) => {
    const hooks = ctx.handlers.get('agent/pre-step') ?? []
    let decision = { messages: [] }
    for (const hook of hooks) {
      decision = await hook({ agent: { session } }, async () => decision)
    }
    return decision
  }

  // off mode: no hook at all.
  {
    const ctx = makeCtx({ sessionQuery: mkSQ(otherRecs) })
    const mounted = registerOnboard({ ...BASE_CONFIG, onboardMode: 'off' }, ctx)
    check('off mode mounts nothing', mounted === false && (ctx.handlers.get('agent/pre-step') ?? []).length === 0)
  }

  // ask → 续接: injects the resume context.
  {
    const ctx = makeCtx({
      sessionQuery: mkSQ(otherRecs),
      userQuestions: { ask: async () => ({ answers: [{ id: 'workspace-onboard', selected: ['续接工作区'] }] }) },
    })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const decision = await firePreStep(ctx, freshSession())
    const text = decision.messages.at(-1)?.content?.[0]?.text ?? ''
    check('ask resume injects one message', decision.messages.length === 1, `messages=${decision.messages.length}`)
    check('resume text lists recent sessions', text.includes('旧会话标题') && text.includes('session-old-1'))
    check('resume text is fenced as data', text.includes('不是指令') && text.includes('[end of workspace resume context]'))
    check('injected message carries the producer kind', decision.messages.at(-1)?.source?.kind === 'plugin:dsh-recall-channel')
  }

  // ask → 不用: injects nothing.
  {
    const ctx = makeCtx({
      sessionQuery: mkSQ(otherRecs),
      userQuestions: { ask: async () => ({ answers: [{ id: 'workspace-onboard', selected: ['不用，直接聊'] }] }) },
    })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const decision = await firePreStep(ctx, freshSession())
    check('ask skip injects nothing', decision.messages.length === 0)
  }

  // ask → user cancels: treated as skip.
  {
    const ctx = makeCtx({
      sessionQuery: mkSQ(otherRecs),
      userQuestions: { ask: async () => { const e = new Error('cancelled'); e.code = 'ASK_CANCELLED'; throw e } },
    })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const decision = await firePreStep(ctx, freshSession())
    check('ask cancel injects nothing', decision.messages.length === 0)
  }

  // ask with NO_PROVIDER: degrades to the notice.
  {
    const ctx = makeCtx({
      sessionQuery: mkSQ(otherRecs),
      userQuestions: { ask: async () => { const e = new Error('no answerer'); e.code = 'NO_PROVIDER'; throw e } },
    })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const decision = await firePreStep(ctx, freshSession())
    const text = decision.messages.at(-1)?.content?.[0]?.text ?? ''
    check('NO_PROVIDER degrades to a notice', decision.messages.length === 1 && text.includes('降级'), text.slice(0, 80))
  }

  // no userQuestions service at all: also degrades.
  {
    const ctx = makeCtx({ sessionQuery: mkSQ(otherRecs) })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const decision = await firePreStep(ctx, freshSession())
    check('missing userQuestions service degrades to a notice', decision.messages.length === 1)
  }

  // notice mode: injects the hint without asking.
  {
    let asked = false
    const ctx = makeCtx({
      sessionQuery: mkSQ(otherRecs),
      userQuestions: { ask: async () => { asked = true; return { answers: [] } } },
    })
    registerOnboard({ ...BASE_CONFIG, onboardMode: 'notice' }, ctx)
    const decision = await firePreStep(ctx, freshSession())
    check('notice mode injects the hint', decision.messages.length === 1)
    check('notice mode never asks', asked === false)
  }

  // not a first turn: an assistant message exists → stay silent.
  {
    const ctx = makeCtx({
      sessionQuery: mkSQ(otherRecs),
      userQuestions: { ask: async () => ({ answers: [{ selected: ['续接工作区'] }] }) },
    })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const session = makeSession([userMsg(0, '你好'), assistantMsg(1, '在的')])
    const decision = await firePreStep(ctx, session)
    check('a session with assistant history is not onboarded', decision.messages.length === 0)
  }

  // one shot per session: the second pre-step stays silent.
  {
    let asks = 0
    const ctx = makeCtx({
      sessionQuery: mkSQ(otherRecs),
      userQuestions: { ask: async () => { asks += 1; return { answers: [{ selected: ['不用，直接聊'] }] } } },
    })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const session = freshSession()
    await firePreStep(ctx, session)
    await firePreStep(ctx, session)
    check('onboarding fires exactly once per session', asks === 1, `asks=${asks}`)
  }

  // no history AND no memory: complete silence.
  {
    let asks = 0
    const ctx = makeCtx({
      sessionQuery: mkSQ([]),
      userQuestions: { ask: async () => { asks += 1; return { answers: [] } } },
    })
    const tmp = mkdtempSync(join(tmpdir(), 'rc-onboard-empty-'))
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const decision = await firePreStep(ctx, makeSession([userMsg(0, 'hi')], { cwd: tmp }))
    check('an empty workspace is left alone', decision.messages.length === 0 && asks === 0)
    rmSync(tmp, { recursive: true, force: true })
  }

  // memory-only workspace (no sessions): the offer still fires and mentions memory.
  {
    const tmp = mkdtempSync(join(tmpdir(), 'rc-onboard-mem-'))
    await appendMemory({ cwd: tmp, sessionId: 'session-x', content: '记忆一条', maxChars: 8000 })
    const ctx = makeCtx({
      sessionQuery: mkSQ([]),
      userQuestions: { ask: async () => ({ answers: [{ selected: ['续接工作区'] }] }) },
    })
    registerOnboard({ ...BASE_CONFIG }, ctx)
    const decision = await firePreStep(ctx, makeSession([userMsg(0, 'hi')], { cwd: tmp }))
    const text = decision.messages.at(-1)?.content?.[0]?.text ?? ''
    check('memory-only workspace resumes with memory injected', decision.messages.length === 1 && text.includes('记忆一条'), text.slice(0, 120))
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ==============================================================================
console.log('workspace_search:')
{
  const sessionA = [
    userMsg(0, '我们在修登录超时的问题'),
    assistantMsg(1, '根因是 token 刷新竞态'),
  ]
  const sessionB = [
    userMsg(0, '回测框架的选型'),
    assistantMsg(1, 'vectorbt 比 backtrader 快得多'),
  ]
  const mkSQ = () => ({
    filterSessions: async () => [
      { header: { id: 'session-a', cwd: 'C:/ws/test', createdAt: 2 }, live: false },
      { header: { id: 'session-b', cwd: 'C:/ws/test', createdAt: 1 }, live: false },
    ],
    readSession: async (sid) => ({ events: sid === 'session-a' ? sessionA : sessionB }),
  })
  const caller = makeSession([userMsg(0, '搜一下')], { cwd: 'C:/ws/test' })
  const exec = { agent: { session: caller } }
  const ctx = makeCtx({ sessionQuery: mkSQ() })
  const tools = createWorkspaceTools({ ...BASE_CONFIG }, ctx)
  const search = tools.find((t) => t.name === 'workspace_search')
  check('workspace_search is built', Boolean(search))

  const hit = await search.execute({ query: '竞态' }, exec)
  check('finds the hit in another session', hit.hits.length === 1 && hit.hits[0].sessionId === 'session-a', JSON.stringify(hit.hits))
  check('hit carries seq and role', hit.hits[0].seq === 1 && hit.hits[0].role === 'assistant')
  check('reports sessions searched', hit.scannedSessions === 2, `scanned=${hit.scannedSessions}`)

  const miss = await search.execute({ query: '不存在的词' }, exec)
  check('no hits reported honestly', miss.hits.length === 0 && miss.scannedSessions === 2)

  const limited = await search.execute({ query: '的', limit: 1 }, exec)
  check('limit is honoured and reported', limited.hits.length === 1 && limited.limitReached === true)

  const capped = await search.execute({ query: '的', maxSessions: 1 }, exec)
  check('maxSessions caps and reports skipped sessions', capped.skippedSessions === 1, `skipped=${capped.skippedSessions}`)

  const tiny = await search.execute({ query: '的' }, { agent: { session: caller } })
  check('substring search spans multiple sessions', tiny.hits.length >= 2 && new Set(tiny.hits.map((h) => h.sessionId)).size === 2)

  // regex mode + hazard refusal
  const rx = await search.execute({ query: '竞态|backtrader', regex: true }, exec)
  check('regex hits across sessions', rx.hits.length >= 2)
  let refused = false
  try { await search.execute({ query: '(a|ab)+', regex: true }, exec) } catch { refused = true }
  check('catastrophic regex is refused', refused)

  // caller's own session is excluded
  const selfCtx = makeCtx({
    sessionQuery: {
      filterSessions: async () => [
        { header: { id: 'session-caller', cwd: 'C:/ws/test', createdAt: 3 }, live: true },
        { header: { id: 'session-a', cwd: 'C:/ws/test', createdAt: 2 }, live: false },
      ],
      readSession: async () => ({ events: sessionA }),
    },
  })
  const selfSearch = createWorkspaceTools({ ...BASE_CONFIG }, selfCtx).find((t) => t.name === 'workspace_search')
  const selfHit = await selfSearch.execute({ query: '搜一下' }, exec)
  check('the caller session is never searched', selfHit.hits.length === 0)
}

// ==============================================================================
console.log('apply() integration:')
{
  const ctx = makeCtx()
  apply(ctx, { ...BASE_CONFIG })
  const names = [...ctx.tools.keys()]
  check('v1.3.0 registers the base tools', names.includes('search_history') && names.includes('recall_history'))
  check('v1.3.0 registers memory tools', names.includes('workspace_remember') && names.includes('workspace_memory') && names.includes('workspace_forget'))
  check('onboard hook is mounted by apply', (ctx.handlers.get('agent/pre-step') ?? []).length >= 1)

  const ctxOff = makeCtx()
  apply(ctxOff, { ...BASE_CONFIG, memoryEnabled: false, onboardMode: 'off' })
  const offNames = [...ctxOff.tools.keys()]
  check('memoryEnabled:false skips memory tools', !offNames.includes('workspace_remember'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('ALL CHECKS PASSED')
