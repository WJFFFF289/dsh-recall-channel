# dsh-recall-channel

给 DeepSeek Harness 的「回忆通道」插件：**压缩后原文不丢，模型需要时能自己取回。**

DSH 的会话日志是 append-only 的，压缩（compaction）只替换"模型能看见的那一层"，原文一直在。缺的只是**一条取回通道**。本插件补上它：

- `search_history` —— 在**整份日志（含被压缩掉的内容）**里检索，返回带 `seq` 坐标的命中；
- `recall_history` —— 按坐标把原文**逐字**取回，带 token 预算与如实的省略说明；
- 每次压缩结束后自动发一条简短提示，告诉模型"这段历史被压了、可以这样取回"。

它**不做**：替换压缩引擎、修改历史事件、自建存储、向量检索。

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

卸载：

```sh
dsh plugin --profile web remove dsh-recall-channel
```

插件不写任何自有数据，删除即干净（历史事件不受影响）。

---

## 配置

全部可选，写进 profile 的 `cordis.patch.yml`：

```yaml
- id: recall-channel
  config:
    enabled: true
    searchLimit: 20              # search_history 默认返回的命中数上限
    snippetChars: 240            # 每条命中的片段宽度
    scanLimit: 50000             # 单次检索最多扫描的事件数（安全阀）
    maxRecallTokens: 16000       # 单次 recall 的 token 预算
    maxSessionRecallTokens: 64000 # 单会话累计取回预算
    includeReasoning: false      # 是否把 reasoning 块也纳入取回文本
    hintOnCompaction: true       # 压缩后是否发提示
```

预算按 `字符数 / 4` 估算 token。超预算时保留**首尾**、省略中间，并在结果末尾写明省略了什么、
怎么用更窄的区间继续取。

---

## 典型用法

压缩之后：

```
用户：我们前面查过的那个故障编号是什么？当时在修什么问题？

模型 → search_history({ query: "ZK-7723" })
     ← 2 处命中（标记为被 cmp-1 遮蔽），带 seq 坐标

模型 → recall_history({ compactionId: "cmp-1" })
     ← 原文逐字返回：编号、当时的命令、工具输出
```

---

## 设计要点（与实现约束）

| 决策 | 原因 |
|---|---|
| **不落盘**，坐标从日志现推 | 日志本身就是地址簿；不存预计算结果就没有漂移，回放永远一致 |
| **用 `shadowedSeqs`，不用 `shadowedRange`** | 后者是"表面位置跨度"，先前替换可能让 `start > end`；前者才是权威集合 |
| **检索扫全量日志，不扫当前表面** | 兼得"被压缩内容"与"窗口截断盲区"两部分 |
| **只追加、不改历史** | 日志是 append-only 真相源，且有 invariant 校验 |
| **打包成自包含产物** | out-of-tree 插件由 Node 从真实路径解析 import，profile 的模块链接层不参与；`dist/index.js` 内联全部依赖，运行时零 import |
| **去重** | 同一段重复取回只回一句提示，避免反复灌 token |
| **单会话累计预算** | 防止"取回 → 又超阈值 → 再压缩 → 再取回"的震荡 |

### 借鉴来源

- **VCC**（lllyasviel/VCC）：坐标只分配一次；不存预计算结果、视图即算即弃；每个块带角色标签
  （这是它区别于裸 grep 的核心）。
- **dsh-compaction-instant / lossless-code**：压缩产物里必须写"如何取回"——不告诉模型，它不会用。
- **remnic LCM / LCM 论文**：取回工具的三段粒度（search / describe / expand）与 16k 量级的单次预算。
- **`@deepseek-ai/dsh-output-retention`**：UTF-8 安全的 head/tail 裁剪。

---

## 开发

```sh
npm run build   # esbuild → dist/index.js（自包含）
npm test        # 机制测试：合成会话日志驱动 anchor + 两个工具
```

`lib/` 是源码，`dist/` 是发布产物；装到 DSH 的是 `dist/index.js`（`package.json` 的 `main`）。

---

# English

A recall channel for DeepSeek Harness. The session log is append-only and
compaction only replaces what the model can see, so shadowed content is still
there — this plugin adds the way back:

- `search_history` searches the **entire** log, including shadowed content, and
  returns `seq` coordinates;
- `recall_history` restores the original text **verbatim**, under a token budget
  with an honest omission notice;
- after each compaction it posts a short notice telling the model that the span
  is still addressable.

It does **not**: replace the compaction engine, modify history, keep its own
store, or build an embedding index.

Install with `dsh plugin --profile web add <path-or-name>`, restart, verify with
`dsh --profile web --dump-config | grep recall-channel`, remove with
`dsh plugin --profile web remove dsh-recall-channel`.

MIT licensed.
