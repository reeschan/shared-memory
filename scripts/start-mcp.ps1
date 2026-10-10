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

if (Test-McpHealth) {
    Write-Output "MCP サーバーは起動済みです ($HealthUrl)"
    exit 0
}

$node = Get-NodePath
if (-not $node) {
    Write-Error 'node が PATH に見つかりません'
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
