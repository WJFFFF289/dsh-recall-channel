# 安装 / 切换 dsh-recall-channel 版本到本机的 DeepSeek Harness
#
# 本脚本是幂等的：如果已经装过 dsh-recall-channel（不论哪个版本、装在哪个目录），
# 会先卸载再安装本目录，因此「跑另一个版本的 install.cmd」就等于升级或回滚。
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
$pluginName = 'dsh-recall-channel'

# ---- 0. 读出本目录的插件版本，安装完成后可据此核对 ----
$pluginVersion = '(未知)'
$pkgPath = Join-Path $pluginDir 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
  try { $pluginVersion = (Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
}

Write-Host "== dsh-recall-channel 安装 / 版本切换器 ==" -ForegroundColor Cyan
Write-Host "插件目录: $pluginDir"
Write-Host "插件版本: v$pluginVersion"

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

$profilePkgPath = Join-Path $DshHome "profiles\$Profile\package.json"

# ---- 3. 安装（先卸后装 = 幂等切换） ----
$env:DSH_HOME = $DshHome
Push-Location -LiteralPath (Join-Path $resources 'dsh')
try {
  $before = (& $node $bin --version 2>&1 | Select-Object -Last 1)
  Write-Host "当前 DSH 版本: $before"

  Write-Host "`n正在卸载已安装的同名插件（若没有则跳过）..." -ForegroundColor Cyan
  $removed = $false
  try {
    & $node $bin plugin --profile $Profile remove $pluginName 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $removed = $true }
  } catch {
    # 未安装时的报错是预期的，继续安装即可。
  }
  if ($removed) { Write-Host "已移除旧版本。" -ForegroundColor Green }
  else { Write-Host "未检测到已安装版本（首次安装）。" }

  Write-Host "`n正在安装本目录的插件 ..." -ForegroundColor Cyan
  & $node $bin plugin --profile $Profile add $pluginDir
  if ($LASTEXITCODE -ne 0) { throw "安装失败（退出码 $LASTEXITCODE）" }

  # ---- 4. 校验组合与链接指向 ----
  Write-Host "`n正在校验 ..." -ForegroundColor Cyan
  $dump = & $node $bin --profile $Profile --dump-config 2>&1
  $hit = $dump | Select-String -Pattern 'recall-channel' -SimpleMatch
  if (-not $hit) { throw "校验失败：组合配置里没有出现 recall-channel 行。" }
  $hit | Select-Object -First 3 | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
} finally {
  Pop-Location
}

# ---- 5. 确认 profile 现在指向的是本目录（版本切换是否真的生效） ----
$linked = $null
if (Test-Path -LiteralPath $profilePkgPath) {
  try {
    $dep = (Get-Content -LiteralPath $profilePkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies.$pluginName
    if ($dep) { $linked = [string]$dep }
  } catch { }
}
if ($linked) {
  Write-Host "profile 依赖: $linked"
  $normalized = $linked -replace '^link:', '' -replace '/', '\'
  if ($normalized.TrimEnd('\') -ieq $pluginDir.TrimEnd('\')) {
    Write-Host "链接指向本目录，版本切换已生效（v$pluginVersion）。" -ForegroundColor Green
  } else {
    Write-Host "注意：profile 仍指向 $normalized，与本目录不同。若刚跑过另一个版本的安装器，请以启动日志里的版本号为准。" -ForegroundColor Yellow
  }
}

Write-Host "`n== 安装成功（v$pluginVersion） ==" -ForegroundColor Green
Write-Host @"

 接下来：
 1) 重启一次 DeepSeek Harness（插件在启动时装载）。
 2) 重启后看启动日志，应出现：[recall-channel] v$pluginVersion ready ...
    这行就是「当前跑的是哪个版本」的凭据。
 3) 验收前先把上下文窗口调小，否则 /compact 会拒绝执行：
    设置 -> 模型 -> DeepSeek -> 编辑模型 -> 上下文窗口  改成 32000
 4) 新建会话，依次执行：
    记一下：故障编号 ZK-7723-PINEAPPLE，是修登录超时时出现的
    （随便再聊几轮）
    /compact
    我们前面那个故障编号是什么？当时在修什么问题？
 5) 通过标准：模型先调用 search_history、再调用 recall_history，编号与场景都答对。
 6) 测完把上下文窗口改回 1000000。

 回滚 / 换版本：
   解压另一个版本的压缩包到另一个目录，双击它的 install.cmd 即可（本脚本会先卸后装）。
   版本凭据同样看启动日志里的 vX.Y.Z。
   若你在 profile 的 cordis.patch.yml 里写过新版本专有的配置键，回滚到旧版本前请先删掉它们。

 卸载：
   dsh plugin --profile $Profile remove $pluginName

 注意：插件是以 link 方式安装的，本文件夹不要移动或删除，否则插件会失效。
"@ -ForegroundColor Yellow
