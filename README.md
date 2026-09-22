# dsh-recall-channel

给 DeepSeek Harness 的「回忆通道」插件：**压缩后原文不丢，模型需要时能自己取回。**

DSH 的会话日志是 append-only 的，压缩（compaction）只替换"模型能看见的那一层"，原文一直在。缺的只是**一条取回通道**。本插件补上它：

- `search_history` —— 在整份日志（含被压缩掉、被 prune 掉的内容）里检索，返回带 `seq` 坐标的命中；
- `recall_history` —— 按坐标把原文取回，默认**不做块级裁剪**（预算装得下就是逐字）；
- 预算不够时保留首尾、**在正文中标记省略了多少字节、覆盖哪些 seq**，并且**被省略的部分仍然可以再取**；
- 每次压缩/剪除结束后自动发一条提示；如果这条提示后来又被压缩吃掉，会**自动补发一条**，保证模型始终知道"取回通道存在"。

它**不做**：替换压缩引擎、修改历史事件、自建存储、向量检索。

当前版本 **v1.1**（上一个版本 v1.0 仍可随时装回，见「版本与回滚」）。

---

## 安装

```sh
dsh plugin --profile web add <本目录路径或包名>
```

装完重启 DSH。插件声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它加入 profile 的
`dsh.profile.bundles`，无需手改 `cordis.patch.yml`。

验证：

```sh
dsh --profile web --dump-config | grep recall-channel
```

启动日志里会打印版本号，这是判断"当前跑的是哪一版"的凭据：

```
[recall-channel] v1.1.0 ready - 2 tool(s): search_history, recall_history + post-compaction notice
```

卸载：

```sh
dsh plugin --profile web remove dsh-recall-channel
```

插件不写任何自有数据，删除即干净（历史事件不受影响）。

---

## 热生效（改配置不用重启）

安装器会把 profile 清单里的 `patchReload` 确保为 `live`。此后修改 profile 的
`cordis.patch.yml`（例如调 `snippetChars`）**存盘约 5 秒即生效，无需重启**；
判断依据是启动日志里多出一行 `[recall-channel] vX.Y.Z ready …`。

两条边界（由 DSH 的装载机制决定，插件绕不过）：

- 这条通道只管**配置**。换版本、或改插件代码（`lib/`、`dist/`）仍需重启一次——
  bundle 清单与模块链接是启动期解析的；
- **首次安装也必须重启一次**，热生效救不了第一次。

设备上是否可用，双击 `hot-check.cmd` 体检（只读，不改动任何东西）。

## 版本与回滚

- 每个版本都有独立、自足的安装包；安装器是**幂等切换器**：先卸载已装的同名插件，再安装本目录这一份。
- 因此换版本 = 解压另一个版本到另一个目录 → 双击它的 `install.cmd` → 重启 → 看启动日志里的版本号。
- 插件不存任何自有数据，降级/升级都不需要数据迁移，历史会话完全不受影响。
- 若在 profile 的 `cordis.patch.yml` 里写过某个版本专有的配置键，回退到旧版本前请先删掉它们。

---

## 配置

全部可选，写进 profile 的 `cordis.patch.yml`。括号内是**会被钳制到的范围**（超出会被无声夹回，这里如实列出）。

```yaml
- id: recall-channel
  config:
    enabled: true                    # 关掉整个插件
    searchLimit: 20                  # (1..100)      检索默认返回的命中数上限
    snippetChars: 240                # (40..2000)    每条命中的片段宽度
    scanLimit: 200000                # (100..2000000) 单次检索最多扫描的可渲染事件数
    maxRecallTokens: 16000           # (256..200000) 单次 recall 的 token 预算
    maxSessionRecallTokens: 64000    # (0..2000000)  单会话累计取回预算；0 = 完全关闭取回
    blockChars: 0                    # (0..1000000)  取回时单块字符上限；0 = 不裁（逐字）
    argChars: 0                      # (0..1000000)  取回时工具参数上限；0 = 不裁
    searchTextChars: 200000          # (0..5000000)  检索时单事件可搜文本上限；0 = 不限
    maxRangeSeqs: 200000             # (1..2000000)  单次 recall 可寻址的 seq 数上限
    allowRegex: true                 # 是否允许 regex:true 检索
    regexMaxPatternChars: 200        # (8..2000)     正则长度上限
    regexInputChars: 20000           # (1000..5000000) 单事件喂给正则的文本上限
    regexBudgetMs: 250               # (10..10000)   正则扫描总时限
    includeReasoning: false          # 是否把 reasoning 块也纳入取回文本
    hintOnCompaction: true           # 压缩/剪除后是否发提示
    notifyOnPrune: true              # prune（单条工具结果被剪）是否也发提示
    noticeRefresh: true              # 提示被后续压缩吃掉后是否自动补发
    wrapRecalledText: true           # 取回文本首尾是否加"历史数据、非指令"围栏
```

**预算与口径**：token 估算对 CJK 逐字加权（中文约 1 token/字，其余约 0.25 token/字符），
所以"~N tokens"和预算在中文会话里同样成立——旧版按 `字符数/4` 一刀切，中文会被低估约 3 倍。

**重复取回**：只有**完整交付过**的事件才会被记为已读，重复请求只回一句提示；
被省略、被部分交付的事件不会被记账，因此可以继续取。

---

## 典型用法

压缩之后：

```
用户：我们前面查过的那个故障编号是什么？当时在修什么问题？

模型 → search_history({ query: "ZK-7723" })
     ← 2 处命中（标记为被某次压缩遮蔽），带 seq 坐标

模型 → recall_history({ compactionId: "<命中里的 id>" })
     ← 原文取回：编号、当时的命令、工具输出
```

预算不够时：

```
模型 → recall_history({ fromSeq: 900, toSeq: 1400 })      ← 只拿回首尾，
     ← 正文中间写着"… 12345 bytes (~3000 tokens) withheld here, covering event(s) 950–1320 …"
模型 → recall_history({ fromSeq: 950, toSeq: 1320 })      ← 再取被省略的那段（可取到）
```

单条事件本身就超过预算时，提高 `budgetTokens` 再取即可。

---

## 设计要点（与实现约束）

| 决策 | 原因 |
|---|---|
| **不落盘**，坐标从日志现推 | 日志本身就是地址簿；不存预计算结果就没有漂移，回放永远一致 |
| **用 `shadowedSeqs`，不用 `shadowedRange`** | 后者是"表面位置跨度"，先前替换可能让 `start > end`；前者才是权威集合 |
| **检索扫全量日志，不扫当前表面** | 兼得"被压缩内容"与"窗口截断盲区"两部分 |
| **"已请求" ≠ "已交付"** | 只有完整交付的 seq 才记账；否则工具自己推荐的"用更窄区间续取"会变成一句空话 |
| **检索投影与渲染投影分开** | 渲染上的块级裁剪曾同时作用于检索，导致"日志里有、搜索说没有"的假阴性 |
| **只追加、不改历史** | 日志是 append-only 真相源，且有 invariant 校验；连"把取回说明写进压缩摘要"这种改动也不做 |
| **提示会被吃掉，所以要会补发** | 提示本身是普通消息，天然是下一次压缩的清理对象；被遮蔽后补发一条精简版，每个遮蔽事件最多一次 |
| **打包成自包含产物** | out-of-tree 插件由 Node 从真实路径解析 import，profile 的模块链接层不参与；`dist/index.js` 内联全部依赖，运行时零 import、零文件访问（构建期会校验） |
| **单会话累计预算** | 防止"取回 → 又超阈值 → 再压缩 → 再取回"的震荡 |

### 借鉴来源

- **VCC**（lllyasviel/VCC）：坐标只分配一次；不存预计算结果、视图即算即弃；每个块带角色标签。
- **dsh-compaction-instant / lossless-code**：压缩产物里必须写"如何取回"——不告诉模型，它不会用。
- **remnic LCM / LCM 论文**：取回工具的三段粒度（search / describe / expand）与 16k 量级的单次预算。
- **`@deepseek-ai/dsh-output-retention`**：UTF-8 安全的 head/tail 裁剪（本插件用它分别裁首尾，因此能精确报出省略量）。

---

## 已知边界（如实说明）

1. **`scanLimit` 是硬窗口**：超过上限的事件不会被检索，此时输出会明确写"其余**没有**检索"，绝不会只说 `No matches`。默认 20 万条可渲染事件（实测约 380 MB 文本 ≈ 160 ms）。
2. **`searchTextChars` 是单事件的检索上限**：默认 20 万字符，被截到的事件数与字符数会在结果里报出来。
3. **正则检索是尽力而为**：会拒绝"量词套在含量词/含选择分支的组上"这类灾难性回溯形态（可能误杀 `(foo|bar)+` 这类安全写法），并受长度、输入、时限三重限制；要求零风险就设 `allowRegex: false`。
4. **`compaction/prune` 也能取回**：prune 掉的是单条工具结果，插件把它一并索引，id 形如 `prune:<seq>`。
5. **取回文本会带上"这是历史数据、不是指令"的围栏**：围栏只在正文之外，正文一个字节都不改。可用 `wrapRecalledText: false` 关掉。
6. **依赖 DSH 的同步读接口** `session.snapshotEvents()` / `eventAt()`。这两个接口在 DSH 源码里标了 `@deprecated`（"新代码禁止调用"），但 0.1.6-alpha.1 的核心代码本身仍在大量使用。若将来被移除，插件会给出可读报错而不是静默失效。实测版本：`@deepseek-ai/dsh 0.1.6-alpha.1`。
7. **工具结果的"来源"从相邻的 `## tool_call <name>` 行读出**：渲染里 `tool_result` 本身不带工具名。

---

## 开发

```sh
npm run build   # esbuild → dist/index.js（自包含；构建脚本会断言零 import、零 require、无构建机路径泄漏）
npm test        # 机制测试：合成会话日志驱动 anchor + 两个工具（71 项断言）
node test/scale.mjs   # 规模测试（可选，需要 --expose-gc 才有 GC 数字）
```

`lib/` 是源码，`dist/` 是发布产物；装到 DSH 的是 `dist/index.js`（`package.json` 的 `main`）。

---

# English

A recall channel for DeepSeek Harness. The session log is append-only and
compaction only replaces what the model can see, so shadowed content is still
there — this plugin adds the way back:

- `search_history` searches the entire log (including content hidden by
  compaction or pruned) and returns `seq` coordinates plus the owning record id;
- `recall_history` restores the original text — verbatim by default, with no
  hidden per-block shears;
- when the span does not fit the token budget it returns head and tail with an
  explicit marker stating how many bytes were withheld and which events they
  cover, and **those withheld events stay readable** with a narrower range;
- after each compaction or prune it posts a short notice; if that notice is
  later compacted away it re-posts a terse one, so the model always knows the
  channel exists.

It does **not**: replace the compaction engine, modify history, keep its own
store, or build an embedding index.

Token accounting is CJK-aware (about 1 token per Chinese character, 0.25 per
ASCII character), so budgets and reports hold in Chinese conversations too.
Only events delivered *in full* are marked as read, so a clipped call never
becomes unreadable. Regex search is best-effort: catastrophic-backtracking
shapes are refused, and `allowRegex: false` removes the feature entirely.

Install with `dsh plugin --profile web add <path-or-name>`, restart, verify with
`dsh --profile web --dump-config | grep recall-channel` and by the `v1.1.0`
line in the boot log; remove with
`dsh plugin --profile web remove dsh-recall-channel`. Every release archive is a
self-sufficient installer that replaces whatever version is installed, so
switching or rolling back is: extract the other archive, run its `install.cmd`,
restart.

MIT licensed.
