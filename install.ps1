# 安装 / 切换 dsh-recall-channel 版本到本机的 DeepSeek Harness
#
# 本脚本是幂等的：如果已经装过 dsh-recall-channel（不论哪个版本、装在哪个目录），
# 会先卸载再安装本目录，因此「跑另一个版本的 install.cmd」就等于升级或回滚。
#
# 除了装卸插件，它还会确保目标设备的「热生效」可用：把 profile 清单里的
# patchReload 显式写成 "live"。这样装完之后，改 cordis.patch.yml 存盘即生效
# （约 5 秒），不需要重启。注意：这条通道只管「配置」；换插件版本或改插件代码
# 仍然需要重启一次（bundle 清单与模块链接是启动期解析的）。
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
#   -PnpmPath pnpm 的位置（目录或 pnpm.cmd 全路径）。不填则自动找 PATH 与常见位置；
#             dsh plugin 命令内部依赖 pnpm，找不到时会给出明确指引。

param(
  [string]$DshRoot,
  [string]$DshHome,
  [string]$Profile = 'web',
  [string]$PnpmPath
)

$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginName = 'dsh-recall-channel'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

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

# ---- 2.5 解析 pnpm（dsh plugin add/remove 靠它，缺了必然失败） ----
#
# `dsh plugin ...` 内部转发给 pnpm，所以 pnpm 必须能找到。桌面版自带 node
# 但**不带 pnpm**，有些机器上 pnpm 也不在 PATH 里，此时会看到
#   'pnpm' is not recognized as an internal or external command
# 这里按「显式参数 → PATH → 常见位置」解析，并把它挂到 PATH 上。
function Resolve-Pnpm {
  param([string]$Explicit)

  if ($Explicit) {
    if (Test-Path -LiteralPath $Explicit -PathType Container) {
      foreach ($name in @('pnpm.cmd', 'pnpm.exe', 'pnpm.ps1', 'pnpm')) {
        $candidate = Join-Path $Explicit $name
        if (Test-Path -LiteralPath $candidate) { return @{ Dir = $Explicit; File = $candidate; Origin = '参数指定目录' } }
      }
      throw "-PnpmPath 指定的目录里没有 pnpm：$Explicit"
    }
    if (Test-Path -LiteralPath $Explicit) {
      return @{ Dir = (Split-Path -Parent $Explicit); File = $Explicit; Origin = '参数指定文件' }
    }
    throw "-PnpmPath 指定的路径不存在：$Explicit"
  }

  $onPath = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($onPath) { return @{ Dir = (Split-Path -Parent $onPath.Source); File = $onPath.Source; Origin = 'PATH' } }

  foreach ($c in @(
    (Join-Path $env:APPDATA 'npm'),
    (Join-Path $env:LOCALAPPDATA 'pnpm'),
    (Join-Path $env:LOCALAPPDATA 'Programs\pnpm')
  )) {
    if ($c) {
      foreach ($name in @('pnpm.cmd', 'pnpm.exe')) {
        $candidate = Join-Path $c $name
        if (Test-Path -LiteralPath $candidate) { return @{ Dir = $c; File = $candidate; Origin = '常见位置' } }
      }
    }
  }
  return $null
}

Write-Host "`n正在解析 pnpm（dsh plugin 命令需要它）..." -ForegroundColor Cyan
$pnpm = Resolve-Pnpm -Explicit $PnpmPath
if (-not $pnpm) {
  throw @"
找不到 pnpm —— 而 'dsh plugin add/remove' 内部就是调用 pnpm 完成的，没有它装不上。

你看到的现象通常是这一行：
  'pnpm' is not recognized as an internal or external command

三种解决办法（任选其一）：
  1) 显式指定（推荐，不改系统环境）：
       install.cmd -PnpmPath "C:\某处\pnpm.cmd"
       install.cmd -PnpmPath "C:\某处\pnpm所在目录"
  2) 把 pnpm 装到 PATH 上，然后重开一个终端再跑本脚本：
       npm install -g pnpm
  3) 如果本机有便携版 pnpm，把它所在目录加到用户 PATH：
       该目录里应当能看到 pnpm.cmd
"@
}
$env:PATH = "$($pnpm.Dir);$env:PATH"
$pnpmVersion = (& $pnpm.File --version 2>&1 | Select-Object -Last 1)
Write-Host "  使用 pnpm: $($pnpm.File)  [$($pnpm.Origin)]" -ForegroundColor Green
Write-Host "  pnpm 版本: $pnpmVersion"

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

  # ---- 4. 校验组合 ----
  Write-Host "`n正在校验 ..." -ForegroundColor Cyan
  $dump = & $node $bin --profile $Profile --dump-config 2>&1
  $hit = $dump | Select-String -Pattern 'recall-channel' -SimpleMatch
  if (-not $hit) { throw "校验失败：组合配置里没有出现 recall-channel 行。" }
  $hit | Select-Object -First 3 | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
} finally {
  Pop-Location
}

# ---- 5. 保证「热生效」可用（把 patchReload 显式写成 live） ----
#
# dsh 只在 profile 清单的 patchReload 取值为 "live" 时，才会装载监视
# cordis.patch.yml 的 HMR 并调用 watchUserPatches()；为 "startup" 时不装监视器，
# 改 patch 文件必须重启。字段缺失时的代码默认值就是 live，所以这一步在 web
# profile 上通常是空操作；它只在你或别的工具把它改成过 "startup" 时才真正动手。
# 改动前会先备份 profile 清单。
function Enable-HotApply {
  if (-not (Test-Path -LiteralPath $profilePkgPath)) {
    Write-Host "  profile 清单不存在，跳过（首次启动 DSH 会自动创建）：$profilePkgPath" -ForegroundColor Yellow
    return
  }
  $json = (Get-Content -LiteralPath $profilePkgPath -Raw -Encoding UTF8) | ConvertFrom-Json
  if ($null -eq $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
  if ($null -eq $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }

  $current = $null
  if ($json.dsh.profile.PSObject.Properties.Name -contains 'patchReload') { $current = [string]$json.dsh.profile.patchReload }

  Write-Host "`n正在确保「热生效」可用（patchReload）..." -ForegroundColor Cyan
  Write-Host ("  当前值: " + $(if ($current) { $current } else { '(未设置，等价于 live)' }))

  if ($current -eq 'live') {
    Write-Host "  已是 live，无需改动。" -ForegroundColor Green
    return
  }

  $backup = "$profilePkgPath.bak-hotapply-$stamp"
  Copy-Item -LiteralPath $profilePkgPath -Destination $backup -Force
  Write-Host "  已备份: $(Split-Path -Leaf $backup)"

  if ($json.dsh.profile.PSObject.Properties.Name -contains 'patchReload') {
    $json.dsh.profile.patchReload = 'live'
  } else {
    $json.dsh.profile | Add-Member -NotePropertyName patchReload -NotePropertyValue 'live' -Force
  }
  [System.IO.File]::WriteAllText($profilePkgPath, ($json | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  已改为 live：改 cordis.patch.yml 存盘后约 5 秒生效，不用重启。" -ForegroundColor Green
  Write-Host "  （想恢复原行为：把上面的 .bak 覆盖回去，或把该字段改回 startup）" -ForegroundColor DarkGray
}

Enable-HotApply

# ---- 6. 确认 profile 现在指向的是本目录（版本切换是否真的生效） ----
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
 1) 重启一次 DeepSeek Harness（插件在启动时装载；换版本/改代码都需要这一步）。
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

 热生效（本脚本已确保可用）：
   装完之后，改 profile 的 cordis.patch.yml（例如调整 snippetChars）存盘即可生效，
   约 5 秒，不需要重启。验证方法：改一个数值，然后看启动日志里是否出现新的一行
   [recall-channel] v$pluginVersion ready ... —— 出现即说明插件被热重载了。
   注意：这条通道只管「配置」；改插件代码（lib/ / dist/）或者换版本仍然需要重启。

 回滚 / 换版本：
   解压另一个版本的压缩包到另一个目录，双击它的 install.cmd 即可（本脚本会先卸后装）。
   版本凭据同样看启动日志里的 vX.Y.Z。
   若你在 profile 的 cordis.patch.yml 里写过新版本专有的配置键，回滚到旧版本前请先删掉它们。
   （v1.1 新增的键：blockChars argChars searchTextChars maxRangeSeqs allowRegex
     regexMaxPatternChars regexInputChars regexBudgetMs notifyOnPrune noticeRefresh wrapRecalledText）

 卸载：
   dsh plugin --profile $Profile remove $pluginName

 注意：插件是以 link 方式安装的，本文件夹不要移动或删除，否则插件会失效。
"@ -ForegroundColor Yellow
