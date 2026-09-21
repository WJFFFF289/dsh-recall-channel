# 安装 dsh-recall-channel 到本机的 DeepSeek Harness
#
# 用法（一般直接双击 install.cmd 即可）：
#   install.cmd
#   install.cmd -DshRoot "D:\某处\DeepSeek Harness"
#   install.cmd -DshRoot "..." -DshHome "C:\Users\xx\AppData\Roaming\deepseek-harness-desktop\dsh-home"
#
# 参数说明：
#   -DshRoot  便携版的 "DeepSeek Harness" 文件夹（里面应有 resources\ 子目录）
#   -DshHome  DSH 数据目录（默认 %APPDATA%\deepseek-harness-desktop\dsh-home）
#   -Profile  profile 名（默认 web）

param(
  [string]$DshRoot,
  [string]$DshHome,
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "== dsh-recall-channel 安装器 ==" -ForegroundColor Cyan
Write-Host "插件目录: $pluginDir"

if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'dist\index.js'))) {
  throw "插件目录不完整：找不到 dist\index.js。请先完整解压压缩包再运行本脚本。"
}

# ---- 1. 找到 DSH 安装目录 ----
if (-not $DshRoot) {
  Write-Host "未指定 -DshRoot，尝试自动探测正在运行的 DeepSeek Harness ..."
  $proc = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -eq 'DeepSeek Harness' -and $_.Path } |
    Select-Object -First 1
  if ($proc) {
    $candidate = Split-Path -Parent $proc.Path
    if (Test-Path -LiteralPath (Join-Path $candidate 'resources\runtime\node.exe')) {
      $DshRoot = $candidate
      Write-Host "已找到: $DshRoot" -ForegroundColor Green
    }
  }
}

if (-not $DshRoot) {
  throw @"
找不到 DeepSeek Harness 安装目录。
请先启动一次 DeepSeek Harness，或用参数显式指定，例如：
  install.cmd -DshRoot "<DSH便携版目录>\DeepSeek-Harness-便携版-0.1.2-alpha.1\DeepSeek Harness"
"@
}

$resources = Join-Path $DshRoot 'resources'
$node = Join-Path $resources 'runtime\node.exe'
$bin = Join-Path $resources 'dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'

foreach ($p in @($node, $bin)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "DSH 安装不完整，缺少: $p" }
}

# ---- 2. 确定数据目录 ----
if (-not $DshHome) { $DshHome = Join-Path $env:APPDATA 'deepseek-harness-desktop\dsh-home' }
if (-not (Test-Path -LiteralPath $DshHome)) {
  throw "找不到 DSH 数据目录: $DshHome。请先启动一次 DeepSeek Harness，或用 -DshHome 指定。"
}
Write-Host "数据目录: $DshHome"
Write-Host "profile : $Profile"

# ---- 3. 记录当前 DSH 版本，便于核对 ----
$env:DSH_HOME = $DshHome
Push-Location -LiteralPath (Join-Path $resources 'dsh')
try {
  $before = (& $node $bin --version 2>&1 | Select-Object -Last 1)
  Write-Host "当前 DSH 版本: $before"

  # ---- 4. 安装 ----
  Write-Host "`n正在安装插件 ..." -ForegroundColor Cyan
  & $node $bin plugin --profile $Profile add $pluginDir
  if ($LASTEXITCODE -ne 0) { throw "安装失败（退出码 $LASTEXITCODE）" }

  # ---- 5. 校验组合 ----
  Write-Host "`n正在校验 ..." -ForegroundColor Cyan
  $dump = & $node $bin --profile $Profile --dump-config 2>&1
  $hit = $dump | Select-String -Pattern 'recall-channel' -SimpleMatch
  if (-not $hit) { throw "校验失败：组合配置里没有出现 recall-channel 行。" }
  $hit | Select-Object -First 3 | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
} finally {
  Pop-Location
}

Write-Host "`n== 安装成功 ==" -ForegroundColor Green
Write-Host @"

接下来：
  1) 重启一次 DeepSeek Harness（插件在启动时装载）。
  2) 验收前先把上下文窗口调小，否则 /compact 会拒绝执行：
     设置 -> 模型 -> DeepSeek -> 编辑模型 -> 上下文窗口  改成 32000
  3) 新建会话，依次执行：
     记一下：故障编号 ZK-7723-PINEAPPLE，是修登录超时时出现的
     （随便再聊几轮）
     /compact
     我们前面那个故障编号是什么？当时在修什么问题？
  4) 通过标准：模型先调用 search_history、再调用 recall_history，编号与场景都答对。
  5) 测完把上下文窗口改回 1000000。

卸载：
  dsh plugin --profile $Profile remove dsh-recall-channel
  （用与上面相同的 node + bin.js 调用方式，或直接删掉 profile 里的该依赖）

注意：插件是以 link 方式安装的，本文件夹不要移动或删除，否则插件会失效。
"@ -ForegroundColor Yellow
