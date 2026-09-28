# CHANGELOG

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
