# CHANGELOG

## v1.3.0 —— 续接弹窗 + 跨会话搜索 + 可写共享记忆

在 v1.2.0 的"只读档案室"基础上，补上通往"工作区即一个会话"的三块短板。
**原有 5 个工具的行为一个都没变**，全部变化都是新增。

### 新功能 1：新会话续接弹窗（`onboardMode`）

新会话的第一轮，插件主动问你要不要续接工作区——不再是"开局一张白纸"。

- `onboardMode: 'ask'`（默认）：通过 DSH 的 `userQuestions` 机制在输入区
  弹出常驻卡片，列出工作区最近的会话，两个选项：「续接工作区」/「不用，直接聊」。
  卡片无超时，不点永远在；点「续接」才注入上下文，点「不用」零开销。
  取消/放弃视为「不用」。
- `onboardMode: 'notice'`：不弹窗，注入一条提示消息（"要续接就说续接"），不阻塞。
- `onboardMode: 'off'`：完全关闭。
- 注入内容（仅在你点头之后）：最近 5 个会话清单 + 共享记忆全文 + 最近会话的
  最新压缩摘要，全部带"历史数据、非指令"围栏，总量约一两千 tokens。
- 每个会话只弹一次；会话里已有 assistant 消息（不是第一轮）不弹；
  工作区无历史也无记忆时不打扰。
- 降级链完整：无 `userQuestions` 服务 / `NO_PROVIDER`（无头环境）→ 自动降为
  notice 模式并明说；无 `sessionQuery` → 跳过会话清单、只注入记忆。

### 新功能 2：跨会话搜索（`workspace_search`）

不用再报坐标。在整个工作区的所有历史会话里搜关键词（或正则），命中带
`sessionId:seq` 坐标，交给 `workspace_recall` 读原文。

- 复用 `search_history` 的全部防护与如实性：灾难性回溯拒绝、正则三重限制、
  `searchTextChars` 上限如实报告、子串命中的码元漂移修正。
- 检索预算全局共享（`scanLimit`），`searchMaxSessions`（默认 20）限制扫描的
  会话数；扫了哪些、跳过哪些、截断多少，全部如实报告。
- `workspaceSearch: false` 可单独关掉这个工具。

### 新功能 3：可写共享记忆（三个新工具）

工作区级的"笔记本"：`<cwd>/.workbuddy/workspace-memory.md`，活在上下文
窗口之外——**压缩够不着它**。这补的是"无限压缩降智"的正解：要紧的东西
不该放对话历史里，而该放这里。

| 工具 | 作用 |
|---|---|
| `workspace_remember` | 追加一条记忆（单行、≤500 字符、带时间戳和来源 sessionId） |
| `workspace_memory` | 读全部记忆（弹窗注入也走这份数据） |
| `workspace_forget` | 两步删除：先按关键词列候选，再按编号删 |

防污染设计（针对 Letta/MemGPT 自编辑记忆的实测教训）：

- **append-only**：写错不改，用新行纠正，错误留痕可查；
- **每行带来源 sessionId**：出问题能追溯到哪个会话写的；
- **有界**：超 `memoryFileMaxChars`（默认 8000）时最老一半滚入
  `workspace-memory.archive.md`（不注入但仍在盘上）；
- **可选写入确认**：`memoryConfirmWrite: true` 时写入前先弹卡片问你，
  拒绝/取消/无弹窗服务一律不写；
- **并发安全**：同工作区的写操作在插件内串行化。

### 新增配置（8 个，全部有默认值）

`onboardMode` `onboardMaxSessions` `onboardSummaryChars` `workspaceSearch`
`searchMaxSessions` `memoryEnabled` `memoryFileMaxChars` `memoryConfirmWrite`

### 修复：`workspace_session_summary` 会静默丢掉压缩摘要

一个会实际误导用户的缺陷，本次一并修掉。

**症状**：不带 `limit` 调用 `workspace_session_summary`（走默认值）时，返回的
可能**全是 prune 记录，一条真正的压缩摘要都没有**——而压缩摘要才是这个工具
存在的意义。

**根因**：工具按事件顺序把 `compaction/summary` 和 `compaction/prune` 收进同一个
数组，然后 `slice(0, limit)`（默认 15）。prune 在日志里通常**远多于**摘要，且
往往成批出现在摘要之前。实测某会话有 27 条 prune 排在 4 条真摘要前面，于是 15
个名额被 prune 全部占满，4 条摘要一条没留下。

**修法**：

- 摘要与 prune 分入两个数组，返回时按 `[...摘要, ...prune]` 排序后再截断。
  prune 再多也挤不掉摘要。
- 新增 `compactionCount` / `pruneCount` / `truncatedCount` 三个输出字段，
  被截掉多少条如实报告，不再闷声丢弃。
- 渲染文本现在会明说"展示 N 条摘要、M 条 prune"，并在有截断时提示
  "还有 K 条低优先级记录未展示，提高 limit 可看"。
- 顺手修正 `limit` 的参数说明（原文写"默认 30"，实际默认 15）。

**回归防护**：`test/live-session.mjs` 新增 2 条断言——默认窗口下**全部摘要
必须存活**、且**摘要必须排在 prune 之前**。

### 硬约束（沿用，一条没破）

不碰压缩引擎；不写其他会话的日志；严格 cwd 隔离；取回内容默认不回喂；
不落盘自有存储（记忆文件在工作区内，是用户资产，不是插件数据）。

### 测试与验证

- 新增 `test/onboard-memory.mjs`：**49 断言**，覆盖记忆写读删滚动、
  弹窗三模式与全部降级路径、跨会话搜索与隔离。
- 新增 `test/workspace.mjs`：**36 断言**，驱动 `workspace_map` /
  `workspace_session_summary` / `workspace_recall` 打真实持久化会话。
- 新增 `test/live-session.mjs`：**42 断言**，用 `SessionStore` 造一个真实
  live 会话，模拟"用户新开一个聊天"，再从这个会话里调用全部工具
  （含上面那 2 条摘要排序回归断言）。
- 新增 `test/e2e-workflow.mjs`：端到端串起
  `workspace_map → workspace_session_summary → workspace_recall`
  的模型真实调用顺序，并带耗时统计。
- `test/mechanics.mjs` 更新 6 条断言以适配"注册 5 工具、挂 2 个 pre-step
  钩子"的新现实（被测行为本身未变）。
- `test/scale.mjs` 压测 20 万事件 / 381 MB 文本，全扫描 229 ms。
- 全部断言在 `@deepseek-ai/dsh-session 0.2.0-rc.1` 运行时树上全绿
  （含 V4 准入校验）。

## v1.2.0 —— 跨会话工作区回忆（三个新工具）

在原有单会话回忆通道不变的前提下，新增同工作区（cwd）跨会话读取能力。新开会话不再需要"全文重读旧会话"——用三层递进的方式按需取回。

### 新增工具（3 个）

| 工具 | 层级 | 作用 |
|---|---|---|
| `workspace_map` | L1 | 列出同工作区的所有会话（一行一个：id、日期、标题、事件数、压缩块数） |
| `workspace_session_summary` | L2 | 读取某个会话的 compaction 摘要列表（每条带 sessionId:seq 坐标） |
| `workspace_recall` | L3 | 按坐标逐字取回另一个会话的原文（复用 recall_history 的渲染和预算逻辑） |

### 设计原则

**给地图，不给档案；让模型自己查，不替它堆。** 启动时上下文是最小可用集（L0 工作区规则 + L1 会话清单），其余全靠模型主动取（L2 摘要 → L3 原文）。

### 硬性约束

- **严格 cwd 隔离**：不同工作目录的会话互相不可见，无 opt-out
- **只读**：不写其他会话，不搞跨会话消息发送
- **默认不回喂**：取回的内容只进 tool/result，不主动塞进模型视野
- **不替换压缩引擎**：继续挂 compaction/* 事件观察
- **不落盘**：不引入自有存储，日志即地址簿

### 技术实现

- 通过 `ctx.sessionQuery`（DSH 0.1.7+ 的 session-query-sqlite 服务）读取 persisted 会话
- 授权模式与 `@deepseek-ai/dsh-tool-session-query` 的 workspace-access 模块一致：`filterSessions([{kind:'id',...},{kind:'cwd',...}])`
- `sessionQuery` 不在 `inject` 里声明——通过 `ctx.get()` 访问，不可用时优雅降级（原有 2 个工具照常工作）
- 跨会话交付账本按 `sessionId:seq` 记账，与单会话账本独立
- L0 工作区规则从 `<cwd>/.workbuddy/recall-rules.md` 读取（如果存在）

### 测试

新增 `test/workspace.mjs`（36 断言）：在真实数据目录下的持久化会话上驱动三个新工具，覆盖注册、L1/L2/L3 功能、cwd 隔离拒绝、去重、预算截断。现有 `test/mechanics.mjs` 82 断言全过。

### 验证环境

- DSH 运行时 `0.1.7-rc.1`（`dsh-session-query` 包版本 `0.1.7-rc.2`）
- 60 个持久化会话（2 个工作区），5 个含 compaction 事件

## v1.1.3 —— 适配 DSH 0.2.0-rc.1（只改兼容声明，代码零改动）

插件源码**一个字节都没改**，`dist/index.js` 只是按新版本号重出。这一版只修
`package.json` 里的一条兼容声明。

### 背景：DSH 0.2.0 起会**拒绝加载**不满足 peer 范围的插件

DSH 从 `dsh-app-boot` 的 `evaluatePluginCompatibility()` 起，在 profile 组装阶段逐个
检查插件 `peerDependencies` 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 条目，
用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 对照**当前运行时
版本**。不满足时抛错 → 该 bundle 根本不会被装载，插件页显示「异常」。这不是警告，是拦停。

旧声明是：

```json
"@deepseek-ai/dsh-session": "^0.1.7-alpha.2"
```

node-semver 把 `^0.1.7-alpha.2` 展开为 `>=0.1.7-alpha.2 <0.2.0-0`。注意上界是
**`0.2.0-0`** 而不是 `0.2.0`——插入的 `-0` 让**任何** `0.2.0-*` 预发布版本都不在范围内，
`0.2.0-rc.1` 自然被拒。（同目录的其他插件用 `>=0.1.7-alpha.1 <0.2.0` 这种手写上界就不踩
这个坑，因为 `0.2.0-rc.1 < 0.2.0` 成立。）

### 修复

```json
"@deepseek-ai/dsh-session": "^0.1.7-alpha.2 || ^0.2.0-rc.1"
```

第二个分支展开为 `>=0.2.0-rc.1 <0.3.0-0`，覆盖整个 0.2.x 线（rc.2、0.2.0 正式版、
0.2.x 补丁都在内），所以 0.2 线内的小版本升级不用再改这一行。

### 依据：为什么 0.2.0-rc.1 是真的兼容，而不是"声明放宽混过去"

对插件实际消费的每一个运行时包，逐字节比对 `0.1.7-rc.2`（上一版实测通过的版本）与
`0.2.0-rc.1` 的 `lib/**`：

| 包 | 用途 | 结果 |
|---|---|---|
| `@deepseek-ai/dsh-llm` | `createUserMessage`（注入通知） | **逐字节相同** |
| `@deepseek-ai/dsh-tools` | `defineTool`（两个工具） | **逐字节相同** |
| `@deepseek-ai/dsh-output-retention` | `TextRetainer`（头/尾保留） | **逐字节相同** |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | `assertV4RowAdmission`（测试里的准入校验） | **逐字节相同** |
| `@deepseek-ai/dsh-session` | `snapshotEvents()` / `eventAt()` / `session.seq` | 19 个文件相同，5 个改动 |

`dsh-session` 的 5 个改动文件全部落在**中断恢复**（`ToolCallRecovery` 从
`interruptedTurnClosers` 里抽出成独立类、崩溃尾/分叉种子共用一套 pending 结算）上，
类型面只有新增（`ToolCallRecovery` 与它的 4 个成员），**没有任何删除**。插件用到的
`snapshotEvents()` / `eventAt()` 在 0.2.0-rc.1 里签名与实现均未变。

`@deepseek-ai/cordis` 不在 DSH 的检查名单里（只有 `dsh*` 前缀被查），但一并核过：
运行时是 4.0.4，声明 `^4.0.2` 依旧满足。

### 验证

- 自带测试在 `0.1.7-rc.2` 树上全绿（含 V4 准入那条）。
- 另在从官方桌面端 `app.asar` 还原出的 `0.2.0-rc.1` 树上重跑，同样全绿。
- 兼容判定按 `dsh-app-boot` 里 `evaluatePluginCompatibility()` 的同一套语义复核：
  修复前能复现出应用里的同一条异常，修复后通过。

## v1.1.2 —— 体检修复批次（如实性 4 项）

插件的工具、参数、配置项**一个都没动**。这一版修的是一轮全面源码体检（对
0.1.7-alpha.2 运行时逐条核验 API 契约后逐行审查）发现的 4 处如实性/精确性缺口：

- **regex 窗口截断零报告**：regex 检索只把每个事件的前 `regexInputChars`（默认 20000）
  字符喂给正则，超出部分从未被检索，但这层截断不计入任何输出——一个 5 万字符事件里
  第 3 万字符处的命中会被答成"无命中"且无附带说明，违反插件自己的规则
  「"No matches" must never mean "I stopped looking"」。现在计入同一对
  `clippedEvents/clippedChars`（同一事件被两种上限同时截到时只记一次），渲染文案改为
  不指名具体配置的如实表述。输出 schema 不变。
- **子串命中的片段窗口可能偏移几个码元**：`toLowerCase()` 对个别字符会改变码元长度
  （如 `İ`→`i̇`），命中坐标是小写化串里的，直接拿去切原文窗口会漂移。新增
  `originalIndexOfLowercased()` 把命中坐标映射回原文（每个命中 O(index)，命中数受限）。
- **控制事件静默跳过、账目对不上**：`request/header`、`step/*` 等不可渲染事件在
  recall 范围内被静默跳过，`delivered+partial+omitted` 与请求数对不上。现在计数并在
  notes 里报一条「N 个事件没有可恢复的文本（控制事件）」。
- **`seqs: [100, 100]` 重复坐标重复渲染、重复计费**：保序去重。

`test/mechanics.mjs` 新增「v1.1.2 regression batch」一节，为上述 4 项各钉一条断言。

## v1.1.1 —— 适配 DSH 0.1.7 的 Session 格式 V4

插件的工具、参数、配置项**一个都没动**。这一版只修一处：消息来源（message source）的
写法。它是被 DSH 0.1.7 的破坏性变更打中的，而且**只在压缩发生时才暴露**。

### 背景：V4 不再接受 `{ kind: 'plugin', plugin }`

DSH 0.1.7 起会话以 **Session format V4** 落盘。V4 的准入规则明确写着
"format v4 message requires a producer-owned source kind"，并**显式拒绝**旧版那个
catch-all 包装（`dsh-session-persistence-jsonl` / `dsh-session-format-v3-to-v4`
里的 `message-sources` 模块，`kind === "plugin"` 直接抛 `SessionFormatError`）。

旧写法是：

```js
source: { kind: 'plugin', plugin: 'dsh-recall-channel', form: 'notice', summary }
```

在 0.1.6 上完全合法；在 0.1.7 上，一旦插件注入通知，**写入会话时就会被拒**。
插件加载本身不会报错（`apply()` 正常、两个工具都注册成功），所以它是一个
**潜伏故障**：只有某个会话真的触发压缩、插件真的去发通知时才会炸，
而那一刻正是它最该工作的时候。

### 修复

- 改为自带身份的生产者 kind：`source: { kind: 'plugin:dsh-recall-channel', form: 'notice', summary }`。
  这个字符串不是随便起的 —— 它是 DSH 自己的 V3→V4 迁移对**未知第三方插件**的兜底命名
  （`producerKind()` 末尾的 `return \`plugin:${plugin}\``）。用同一个名字，历史通知
  和新的通知就被同一条规则识别。
- 识别逻辑升级为 `isOwnSource()`，**两种写法都认**：V4 的 `plugin:dsh-recall-channel`，
  以及尚未迁移、仍以 V3 读取的会话里的 `{ kind: 'plugin', plugin: 'dsh-recall-channel' }`。
  这保证"标准提示是否已被压缩吃掉"的续发判断在迁移前后都成立。
- `peerDependencies` 的 `@deepseek-ai/dsh-session` 由 `^0.1.6-alpha.1` 提到 `^0.1.7-alpha.2`。

### 旧会话与旧数据

- **不丢、不改、不需迁移**：V3 编解码器里 `case "plugin":` 分支只要求 `plugin` 是非空字符串，
  **不限制插件名**，所以已存有本插件通知的 V3 会话在 0.1.7 下照常可读。
- 会话被迁移到 V4 时，这些历史消息会被重写成 `kind: 'plugin:dsh-recall-channel'`，
  与本版新发的通知一致。

### 测试

`test/mechanics.mjs` 新增一节，直接驱动真实的注入路径（boot `apply()` → 喂
`compaction/end` → 跑 `agent/pre-step`），并把**实际发出的消息**交给 DSH 自己的
`assertV4RowAdmission()` 校验，同时反向断言旧写法会被拒。在 0.1.7 上 6/6 通过；
在 0.1.6 上该检查自动跳过（那个版本没有 V4 包）。

## v1.1.0 —— 修复"如实"与"可续取"两条承诺

对四份外部审查报告的处置记录保留在本地，未随仓库发布。下面是相对 v1.0 的**行为变更**；
工具参数（`query` / `regex` / `scope` / `limit` / `compactionId` / `seqs` /
`fromSeq` / `toSeq` / `budgetTokens`）**一个都没有增删**，所以新旧版本之间来回切换
不会留下提示词层面的差异。

### 修复（会让模型看到不同结果）

1. **预算截断后仍可续取**（最重要）。只有**完整交付**的事件才记为已读；被省略或
   部分交付的事件不再被去重挡住。旧版在一次截断调用之后会对更窄的区间回
   "already restored"，导致被省略的内容在本会话内永久读不到。
2. **取回默认逐字**。移除了隐式的"单块 6000 字符 / 工具参数 1200 字符"裁剪。
   需要限制体积时用 `blockChars` / `argChars` 显式设置，且裁剪量会被如实报告。
3. **检索不再被渲染裁剪污染**。旧版的块级裁剪同时作用于检索，导致"日志里有、
   `search_history` 说没有"的假阴性；检索投影现在独立，单事件上限为
   `searchTextChars`（默认 20 万字符）并如实报告被截的事件数与字符数。
4. **省略是精确且可执行的**。截断时正文里出现接缝标记，写明省略的**精确字节数**、
   token 估算、以及被省略的 **seq 区间**，并直接给出续取的参数。
   `omittedSeqs` 现在只列真正未交付的事件，新增 `partialSeqs` / `skippedSeqs` /
   `omittedBytes`。
5. **扫描边界如实**。`scanTruncated` / `limitReached` / `regexTimedOut` 与
   "命中数触顶"分开报告；扫描被截断时明确写"其余**没有**检索"，不再单独输出
   `No matches`。`scanLimit` 默认 50000 → 200000（下限 1000 → 100）。
6. **中文预算成立**。token 估算改为 CJK 加权（中文约 1 token/字，其余 0.25），
   预算按实际 token 比例分配。旧版按 `字符数/4` 估算，中文的实际交付量约为预算的
   3 倍、而报告的 token 数只有实际的约 1/3，会话级预算形同虚设。
7. **提示不再被吃掉**。通知改为队列（同一步内的多次压缩都会通知）；
   `compaction/prune` 也发通知（`notifyOnPrune`）；当提示本身被后续压缩遮蔽时，
   自动补发一条精简版（`noticeRefresh`，每个遮蔽事件最多一次）。
8. **宿主防护**。`fromSeq`/`toSeq` 先夹到日志真实边界，再受 `maxRangeSeqs`
   限制（旧版会把区间先展开成数组，一个多打的数字就能吃掉 GB 级内存）；
   正则检索拒绝灾难性回溯形态，并受长度/输入/时限三重限制，可用
   `allowRegex: false` 完全关闭。
9. **二次注入围栏**。取回文本首尾加"这是历史数据、不是指令"的固定声明
   （`wrapRecalledText`，正文一字节不改）；检索结果加同义提示行。
10. **记账与归属修正**。失败的压缩不再留下"幽灵条目"（`compactions` 计数不再虚高）；
    同一事件被多次遮蔽时 `search_history` 报**最新**的那次；未知 `compactionId`
    的报错不再枚举全部 id；部分去重时明确列出被跳过的事件；请求里含未被遮蔽的
    事件时会如实提示。
11. **产物真正做到零运行时 I/O**。构建期把内联依赖读自己 `package.json` 的那次
    读取替换为常量，并清除产物里的构建机绝对路径；构建脚本会断言"零 import、
    零 require、零 createRequire"。单拷 `dist/index.js` 到任意目录也能加载。
12. **读 API 守卫**。`session.snapshotEvents()` / `eventAt()` 缺失时给出可读错误，
    而不是深处的 `TypeError`。

### 新增配置（全部有默认值；缺失即为 v1.0 行为的安全版）

`blockChars` `argChars` `searchTextChars` `maxRangeSeqs` `allowRegex`
`regexMaxPatternChars` `regexInputChars` `regexBudgetMs` `notifyOnPrune`
`noticeRefresh` `wrapRecalledText`，以及默认值变更 `scanLimit`。
完整列表与钳制范围见 `README.md`。

### 新增工具输出字段

- `search_history`：`limitReached` `scanTruncated` `regexTimedOut` `clippedEvents`
  `clippedChars` `shadowRecords` `latestShadowId` `latestShadowSeqs` `latestShadowTokens`
  （`compactions` 重命名为 `shadowRecords`：它统计压缩与 prune 的总数）
- `recall_history`：`partialSeqs` `skippedSeqs` `omittedBytes` `clippedEvents` `clippedChars`

### 兼容性

- 不改变任何工具参数；不写历史；不落盘；无数据迁移。
- 自带测试从 24 项断言扩到 **71 项**（覆盖上述每一条修复）。
- 实测环境：`@deepseek-ai/dsh 0.1.6-alpha.1`。

---

## v1.0.0 —— 定版与可回滚

相对最初的 0.1.0 发布版，仅做工程性改动，**行为不变**：

- 版本号定名为 **v1.0**（`package.json` 1.0.0），并在启动日志里打印版本号：
  `[recall-channel] v1.0.0 ready - ...`，用于确认当前装载的是哪一版。
- 安装器改为**幂等版本切换器**：先卸载已装的同名插件再安装本目录，因此
  "跑另一个版本的 install.cmd"就等于升级或回滚；安装后额外核对 profile 的
  链接是否指向本目录。
- `dist/index.js` 的构建加入"内联依赖版本读取"替换与构建机路径清理，
  构建脚本对产物做零 import / 零 require 断言。

---

## 0.1.0 —— 首个发布版

- `search_history`（整份日志检索，含被压缩内容）+ `recall_history`（按坐标取回）。
- 压缩后一次性提示；单会话累计预算；按 seq 去重。
- 自包含 `dist/index.js`（内联全部依赖，不需要目标机联网或 node_modules）。
