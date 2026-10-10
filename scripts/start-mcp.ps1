# shared-memory の MCP サーバーを (止まっていれば) 非表示で起動する。
# 既に http://127.0.0.1:7820/health が応答していれば何もしない。
# 使い方: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-mcp.ps1 [-WhatIf]
param(
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HealthUrl = 'http://127.0.0.1:7820/health'
$ServerScript = 'packages\mcp-server\src\server.ts'
$LogDir = Join-Path $Root '.cache\logs'
$LogFile = Join-Path $LogDir 'mcp.log'
$WaitSeconds = 20

function Test-McpHealth {
    try {
        $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        return ($null -ne $r -and $r.ok -eq $true)
    } catch {
        return $false
    }
}

# fnm などのシェルごとの一時ディレクトリ (ジャンクション) を経由している場合は実体側のパスにする
function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return $null }
    $path = $cmd.Source
    $dir = Get-Item -LiteralPath (Split-Path $path) -Force
    if ($dir.LinkType -eq 'Junction' -or $dir.LinkType -eq 'SymbolicLink') {
        $target = @($dir.Target)[0]
        if ($target) { $path = Join-Path $target (Split-Path $path -Leaf) }
    }
    return $path
}

# TypeScript を直接実行できる Node (24 以上) を返す。
# タスクスケジューラから起動すると fnm の環境が無く、PATH の node が古い版になることがあるため、
# その場合は fnm がインストールした版のうち一番新しいものを使う
function Get-TsNodePath {
    $path = Get-NodePath
    if ($path -and (Test-NodeMajor $path)) { return $path }
    $versions = Join-Path $env:APPDATA 'fnm\node-versions'
    if (Test-Path $versions) {
        $found = Get-ChildItem $versions -Directory -Filter 'v*' |
            Sort-Object { [version]($_.Name.TrimStart('v')) } -Descending |
            ForEach-Object { Join-Path $_.FullName 'installation\node.exe' } |
            Where-Object { (Test-Path $_) -and (Test-NodeMajor $_) } |
            Select-Object -First 1
        if ($found) { return $found }
    }
    return $null
}

function Test-NodeMajor([string]$path) {
    try {
        $v = (& $path -v) -replace '^v', ''
        return ([version]$v).Major -ge 24
    } catch {
        return $false
    }
}

if (Test-McpHealth) {
    Write-Output "MCP サーバーは起動済みです ($HealthUrl)"
    exit 0
}

$node = Get-TsNodePath
if (-not $node) {
    Write-Error 'Node 24 以上が見つかりません (PATH と fnm の node-versions を探しました)'
    exit 1
}

# cmd.exe 経由で起動し、標準出力/エラーをログに追記する
$cmdLine = '/c ""' + $node + '" "' + $ServerScript + '" >> "' + $LogFile + '" 2>&1"'

if ($WhatIf) {
    Write-Output "WhatIf: ログディレクトリを作成: $LogDir"
    Write-Output "WhatIf: 非表示で起動: cmd.exe $cmdLine (作業ディレクトリ: $Root)"
    Write-Output "WhatIf: 最大 $WaitSeconds 秒 $HealthUrl の応答を待つ"
    exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
[System.IO.File]::AppendAllText($LogFile, ("==== start-mcp " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " ====`r`n"), (New-Object System.Text.UTF8Encoding $false))

Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -WorkingDirectory $Root -WindowStyle Hidden | Out-Null

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-McpHealth) {
        Write-Output "MCP サーバーを起動しました ($HealthUrl)"
        exit 0
    }
}

Write-Error "MCP サーバーが $WaitSeconds 秒以内に応答しませんでした。ログを確認してください: $LogFile"
exit 1
