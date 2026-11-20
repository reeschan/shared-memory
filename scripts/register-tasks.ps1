# shared-memory の定期タスクを Windows のタスクスケジューラに登録する (現在のユーザー、管理者権限不要)。
#   SharedMemory-MCP   … ログオン時に scripts\start-mcp.ps1
#   SharedMemory-Decay … 毎日 09:00 に node packages\indexer\src\cli.ts decay
#   SharedMemory-GC    … 毎週日曜 09:30 に node packages\indexer\src\cli.ts gc
#   SharedMemory-Eval  … 毎週日曜 10:00 に cli.ts eval --notify のあと cli.ts feedback --notify (トーストで知らせる)
# ログは .cache\logs\<タスク名>.log に追記する。既存のタスクは上書き登録する (何度実行しても同じ結果)。
# 使い方:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1            # 登録
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Unregister # 4 つを削除
#   ... -WhatIf を付けると内容を表示するだけで何も変えない
# Node は TypeScript を直接動かせる 24 以上を選ぶ (PATH の node が古ければ fnm の版。scripts\node-path.ps1)。
# MCP を SSH 先で動かす構成 (トーストを見る PC と、データのある PC が別) では:
#   SSH 先で    : register-tasks.ps1 -NoEval (トーストが誰にも見えない SSH 先には Eval を置かない)
#   手元の PC で: register-tasks.ps1 -RemoteEval <user>@<server> -RemoteRoot C:/Users/<user>/dev/shared-memory
#                 (SharedMemory-Eval だけを登録する。SSH 先で eval と feedback を動かし、トーストは手元に出す。
#                  判定の画面の URL は 127.0.0.1:<mcp.port> なので、手元から SSH 先へのポート転送が要る)
param(
    [switch]$Unregister,
    [switch]$WhatIf,
    [switch]$NoEval,
    [string]$RemoteEval = '',
    [string]$RemoteRoot = ''
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogDir = Join-Path $Root '.cache\logs'
# SSH セッションでは $env:USERDOMAIN が WORKGROUP になり、タスクの実行ユーザーを解決できないことがあるため、実行中のアカウント名を使う
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

. (Join-Path $PSScriptRoot 'node-path.ps1')

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

if ($NoEval -and $RemoteEval -ne '') {
    Write-Error '-NoEval と -RemoteEval は同時に指定できません'
    exit 1
}
if (($RemoteEval -eq '') -ne ($RemoteRoot -eq '')) {
    Write-Error '-RemoteEval と -RemoteRoot は両方指定してください'
    exit 1
}

$TaskNames = if ($RemoteEval -ne '') { @('SharedMemory-Eval') }
    elseif ($NoEval) { @('SharedMemory-MCP', 'SharedMemory-Decay', 'SharedMemory-GC') }
    else { @('SharedMemory-MCP', 'SharedMemory-Decay', 'SharedMemory-GC', 'SharedMemory-Eval') }

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
$node = Get-TsNodePath
if (-not $node) {
    # -RemoteEval では手元で node を動かさないので、見つからなくてもよい
    if ($WhatIf -or $RemoteEval -ne '') {
        if ($RemoteEval -eq '') { Write-Warning 'Node 24 以上が見つかりません (表示上は node.exe とします)' }
        $node = 'node.exe'
    } else {
        Write-Error 'Node 24 以上が見つかりません (PATH と fnm の node-versions を探しました)'
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
    },
    @{
        Name        = 'SharedMemory-Eval'
        Description = 'shared-memory: 毎週 gc のあとに評価し (eval --notify)、判定の画面を知らせる (feedback --notify)'
        TriggerText = '毎週日曜 10:00'
        Trigger     = { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '10:00' }
        # 2 つのコマンドの出力をどちらもログに送るため、スクリプトブロックにまとめる。
        # feedback --notify は通知できたときは URL (合言葉入り) を出さない。
        # eval が失敗したら (feedback が成功しても) その終了コードでタスクを失敗にする
        Command     = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & { & $nodeLit $cliLit eval --notify; `$evalCode = `$LASTEXITCODE; & $nodeLit $cliLit feedback --notify; if (`$evalCode -ne 0) { cmd /c exit `$evalCode } }"
        TimeLimit   = (New-TimeSpan -Hours 1)
    }
)

if ($RemoteEval -ne '') {
    $remoteLit = ConvertTo-PsLiteral (Join-Path $Root 'scripts\remote-eval.ps1')
    $Tasks = @(@{
        Name        = 'SharedMemory-Eval'
        Description = "shared-memory: 毎週 SSH 先 ($RemoteEval) で eval と feedback を動かし、判定の画面をこの PC のトーストで知らせる"
        TriggerText = '毎週日曜 10:00'
        Trigger     = { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '10:00' }
        Command     = "& $remoteLit -Ssh $(ConvertTo-PsLiteral $RemoteEval) -RemoteRoot $(ConvertTo-PsLiteral $RemoteRoot)"
        TimeLimit   = (New-TimeSpan -Hours 1)
    })
} elseif ($NoEval) {
    $Tasks = @($Tasks | Where-Object { $_.Name -ne 'SharedMemory-Eval' })
}

foreach ($t in $Tasks) {
    $logFile = Join-Path $LogDir ($t.Name + '.log')
    $argument = New-LoggedArgument $t.Command $logFile
    $existing = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
    $verb = if ($null -eq $existing) { '新規登録' } else { '上書き登録' }

    if ($WhatIf) {
        Write-Output "WhatIf: タスクを${verb}: $($t.Name)"
        Write-Output "  トリガー   : $($t.TriggerText)"
        Write-Output "  実行       : conhost.exe --headless powershell.exe $argument"
        Write-Output "  作業フォルダ: $Root"
        Write-Output "  ログ       : $logFile"
        Write-Output "  実行ユーザー: $UserId (通常権限)"
        continue
    }

    # powershell.exe を直接起動すると、-WindowStyle Hidden でも隠れる前にコンソールが一瞬表示される。
    # conhost.exe --headless を通すとウィンドウを作らずに動く
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe ' + $argument) -WorkingDirectory $Root
    $trigger = & $t.Trigger
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit $t.TimeLimit
    Register-ScheduledTask -TaskName $t.Name -Description $t.Description -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Output "${verb}しました: $($t.Name) ($($t.TriggerText)) ログ: $logFile"
}

exit 0
