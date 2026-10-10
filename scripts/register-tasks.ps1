# shared-memory の定期タスクを Windows のタスクスケジューラに登録する (現在のユーザー、管理者権限不要)。
#   SharedMemory-MCP   … ログオン時に scripts\start-mcp.ps1
#   SharedMemory-Decay … 毎日 09:00 に node packages\indexer\src\cli.ts decay
#   SharedMemory-GC    … 毎週日曜 09:30 に node packages\indexer\src\cli.ts gc
# ログは .cache\logs\<タスク名>.log に追記する。既存のタスクは上書き登録する (何度実行しても同じ結果)。
# 使い方:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1            # 登録
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Unregister # 3 つを削除
#   ... -WhatIf を付けると内容を表示するだけで何も変えない
param(
    [switch]$Unregister,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogDir = Join-Path $Root '.cache\logs'
$UserId = "$env:USERDOMAIN\$env:USERNAME"

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

# PowerShell の単一引用符文字列にする
function ConvertTo-PsLiteral([string]$s) {
    return "'" + $s.Replace("'", "''") + "'"
}

# コマンドを実行し、出力をログに追記する powershell.exe の引数を作る
function New-LoggedArgument([string]$commandText, [string]$logFile) {
    $log = ConvertTo-PsLiteral $logFile
    $dir = ConvertTo-PsLiteral $LogDir
    $inner = "New-Item -ItemType Directory -Force -Path $dir | Out-Null; " +
        "('==== ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ====') | Out-File -FilePath $log -Append -Encoding utf8; " +
        "$commandText 2>&1 | ForEach-Object { [string]`$_ } | Out-File -FilePath $log -Append -Encoding utf8; " +
        "exit `$LASTEXITCODE"
    return '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "' + $inner + '"'
}

$TaskNames = @('SharedMemory-MCP', 'SharedMemory-Decay', 'SharedMemory-GC')

# ---- 削除 ----
if ($Unregister) {
    foreach ($name in $TaskNames) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($null -eq $existing) {
            Write-Output "スキップ: $name は登録されていません"
            continue
        }
        if ($WhatIf) {
            Write-Output "WhatIf: タスクを削除: $name"
        } else {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Output "削除しました: $name"
        }
    }
    exit 0
}

# ---- 登録 ----
$node = Get-NodePath
if (-not $node) {
    if ($WhatIf) {
        Write-Warning 'node が PATH に見つかりません (表示上は node.exe とします)'
        $node = 'node.exe'
    } else {
        Write-Error 'node が PATH に見つかりません'
        exit 1
    }
}

$nodeLit = ConvertTo-PsLiteral $node
$cliLit = ConvertTo-PsLiteral 'packages\indexer\src\cli.ts'
$startMcpLit = ConvertTo-PsLiteral (Join-Path $Root 'scripts\start-mcp.ps1')

$Tasks = @(
    @{
        Name        = 'SharedMemory-MCP'
        Description = 'shared-memory: ログオン時に MCP サーバーを起動する'
        TriggerText = "ログオン時 ($UserId)"
        Trigger     = { New-ScheduledTaskTrigger -AtLogOn -User $UserId }
        Command     = "& $startMcpLit"
        TimeLimit   = (New-TimeSpan -Minutes 5)
    },
    @{
        Name        = 'SharedMemory-Decay'
        Description = 'shared-memory: 毎日 tier を再計算する (decay)'
        TriggerText = '毎日 09:00'
        Trigger     = { New-ScheduledTaskTrigger -Daily -At '09:00' }
        Command     = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & $nodeLit $cliLit decay"
        TimeLimit   = (New-TimeSpan -Hours 1)
    },
    @{
        Name        = 'SharedMemory-GC'
        Description = 'shared-memory: 毎週 置き換え済みメモリを降格する (gc)'
        TriggerText = '毎週日曜 09:30'
        Trigger     = { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '09:30' }
        Command     = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & $nodeLit $cliLit gc"
        TimeLimit   = (New-TimeSpan -Hours 1)
    }
)

foreach ($t in $Tasks) {
    $logFile = Join-Path $LogDir ($t.Name + '.log')
    $argument = New-LoggedArgument $t.Command $logFile
    $existing = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
    $verb = if ($null -eq $existing) { '新規登録' } else { '上書き登録' }

    if ($WhatIf) {
        Write-Output "WhatIf: タスクを${verb}: $($t.Name)"
        Write-Output "  トリガー   : $($t.TriggerText)"
        Write-Output "  実行       : powershell.exe $argument"
        Write-Output "  作業フォルダ: $Root"
        Write-Output "  ログ       : $logFile"
        Write-Output "  実行ユーザー: $UserId (通常権限)"
        continue
    }

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $Root
    $trigger = & $t.Trigger
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit $t.TimeLimit
    Register-ScheduledTask -TaskName $t.Name -Description $t.Description -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Output "${verb}しました: $($t.Name) ($($t.TriggerText)) ログ: $logFile"
}

exit 0
