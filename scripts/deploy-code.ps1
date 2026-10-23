# scripts/publish-code.mjs が配った shared-memory のコードを、このリポジトリ (作業フォルダー) へ反映する。
# サーバー PC で動かす。<SourceDir>\manifest.json の版がまだ反映していないものなら、次を行う。
#   1. <SourceDir>\files の中身が manifest のハッシュとすべて一致するのを待つ (配布の途中なら何もせずに終わる)
#   2. 変わるファイルを .cache\deploy\backup\<日時> に控えてから、作業フォルダーへ反映する
#      (前回の manifest にあって今回に無いファイルは消す。node_modules や state など配布対象外のものには触れない)
#   3. 依存 (package.json / pnpm-lock.yaml など) が変わっていれば pnpm install --frozen-lockfile
#   4. 実行に関わるファイル (packages\ / config.yaml / 依存) が変わっていれば MCP サーバーを再起動する
#   5. 再起動して応答しなければ控えから元に戻して再起動し、その版は .cache\deploy\failed.json に記録して再試行しない
# opensearch\ と docker-compose.yml の変更は反映するだけで、イメージの再ビルドはしない (ログに警告を出す)。
# ログは .cache\logs\deploy-code.log。
# 使い方:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-code.ps1 -SourceDir <配布先>            # 1 回反映
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-code.ps1 -SourceDir <配布先> -Register  # タスク登録
#   ... -Register -Unregister でタスクを削除
# -Register は SharedMemory-Deploy (ログオン時と 5 分おき) を登録する。配布側は配った直後に
# `schtasks /run /tn SharedMemory-Deploy` で即時に起動する。
param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [switch]$Register,
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaskName = 'SharedMemory-Deploy'
$LogDir = Join-Path $Root '.cache\logs'
$LogFile = Join-Path $LogDir 'deploy-code.log'
$StateDir = Join-Path $Root '.cache\deploy'
$DeployedFile = Join-Path $StateDir 'deployed.json'
$FailedFile = Join-Path $StateDir 'failed.json'
$BackupRoot = Join-Path $StateDir 'backup'
$KeepBackups = 5
$HealthUrl = 'http://127.0.0.1:7820/health'
$DepsPattern = '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages/[^/]+/package\.json)$'
$RuntimePattern = '^(packages/|config\.yaml$|tsconfig(\.base)?\.json$|scripts/start-mcp\.ps1$)'
$InfraPattern = '^(opensearch/|docker-compose\.yml$)'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Write-Log([string]$msg) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg
    [System.IO.File]::AppendAllText($LogFile, $line + "`r`n", $Utf8)
    Write-Output $line
}

# ---- タスクの登録 / 削除 ----
if ($Register) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Unregister) {
        if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Output "削除しました: $TaskName" }
        else { Write-Output "スキップ: $TaskName は登録されていません" }
        exit 0
    }
    # SSH セッションでは $env:USERDOMAIN が WORKGROUP になることがあるため、実行中のアカウント名を使う
    $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $self = Join-Path $Root 'scripts\deploy-code.ps1'
    $argument = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $self + '" -SourceDir "' + $SourceDir + '"'
    # powershell.exe を直接起動すると、-WindowStyle Hidden でも隠れる前にコンソールが一瞬表示される。
    # conhost.exe --headless を通すとウィンドウを作らずに動く
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe ' + $argument) -WorkingDirectory $Root
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $userId),
        (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
    )
    # 対話ログオンで動かす (同期フォルダーのオンラインのみのファイルや資格情報は、対話セッションでないと扱えない)
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
    Register-ScheduledTask -TaskName $TaskName -Description 'shared-memory: 配布されたコードを反映し、必要なら MCP サーバーを再起動する' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
    $verb = if ($existing) { '上書き登録' } else { '新規登録' }
    Write-Output "${verb}しました: $TaskName (ログオン時と 5 分おき、配布元: $SourceDir) ログ: $LogFile"
    exit 0
}

# ---- 反映 ----
function Read-Json([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return [System.IO.File]::ReadAllText($path, $Utf8) | ConvertFrom-Json
}

function Get-Sha256([string]$path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# manifest の files (PSCustomObject) を、相対パス -> ハッシュ の Hashtable にする
function ConvertTo-FileMap($files) {
    $map = @{}
    if ($null -ne $files) { foreach ($p in $files.PSObject.Properties) { $map[$p.Name] = [string]$p.Value } }
    return $map
}

function Get-LocalPath([string]$base, [string]$rel) {
    return Join-Path $base ($rel -replace '/', '\')
}

function Get-TsNodeDir {
    $versions = Join-Path $env:APPDATA 'fnm\node-versions'
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        try { if (([version]((& $cmd.Source -v) -replace '^v', '')).Major -ge 24) { return (Split-Path $cmd.Source) } } catch {}
    }
    if (Test-Path $versions) {
        $found = Get-ChildItem $versions -Directory -Filter 'v*' |
            Sort-Object { [version]($_.Name.TrimStart('v')) } -Descending |
            ForEach-Object { Join-Path $_.FullName 'installation' } |
            Where-Object { Test-Path (Join-Path $_ 'node.exe') } |
            Select-Object -First 1
        if ($found) { return $found }
    }
    return $null
}

function Invoke-PnpmInstall {
    $nodeDir = Get-TsNodeDir
    if (-not $nodeDir) { throw 'Node 24 以上が見つかりません' }
    $pnpm = Join-Path $nodeDir 'pnpm.cmd'
    if (-not (Test-Path $pnpm)) { throw "pnpm が見つかりません: $pnpm" }
    $env:Path = "$nodeDir;" + $env:Path
    $out = & $pnpm install --frozen-lockfile 2>&1 | ForEach-Object { [string]$_ }
    $code = $LASTEXITCODE
    Write-Log ("pnpm install: exit $code " + (($out | Select-Object -Last 3) -join ' / '))
    if ($code -ne 0) { throw "pnpm install が失敗しました (exit $code)" }
}

function Restart-Mcp {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*packages\mcp-server\src\server.ts*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\start-mcp.ps1') 2>&1 | ForEach-Object { Write-Log ("start-mcp: " + [string]$_) }
    try { return ((Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3).ok -eq $true) } catch { return $false }
}

try {
    $manifestPath = Join-Path $SourceDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { exit 0 }
    $manifest = Read-Json $manifestPath
    $version = [string]$manifest.version
    $deployed = Read-Json $DeployedFile
    if ($deployed -and $deployed.version -eq $version) { exit 0 }
    $failed = Read-Json $FailedFile
    if ($failed -and $failed.version -eq $version) { exit 0 }

    $next = ConvertTo-FileMap $manifest.files
    $prev = if ($deployed) { ConvertTo-FileMap $deployed.files } else { @{} }
    $filesDir = Join-Path $SourceDir 'files'

    # 配布の途中 (ハッシュが揃わない) なら次の回に回す
    foreach ($rel in $next.Keys) {
        $src = Get-LocalPath $filesDir $rel
        if (-not (Test-Path -LiteralPath $src) -or (Get-Sha256 $src) -ne $next[$rel]) {
            Write-Log "待機: 配布の途中です ($rel が manifest と一致しません) version=$($version.Substring(0,12))"
            exit 0
        }
    }

    $changed = @($next.Keys | Where-Object {
        $dst = Get-LocalPath $Root $_
        -not (Test-Path -LiteralPath $dst) -or (Get-Sha256 $dst) -ne $next[$_]
    } | Sort-Object)
    $removed = @($prev.Keys | Where-Object { -not $next.ContainsKey($_) -and (Test-Path -LiteralPath (Get-LocalPath $Root $_)) } | Sort-Object)

    if ($changed.Count -eq 0 -and $removed.Count -eq 0) {
        New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
        [System.IO.File]::WriteAllText($DeployedFile, ($manifest | ConvertTo-Json -Depth 5), $Utf8)
        Write-Log "変更なし: version=$($version.Substring(0,12)) を反映済みとして記録"
        exit 0
    }

    # 控えを取る (既存のファイルはコピー、新しく増えるファイルは一覧に残して戻すときに消す)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = Join-Path $BackupRoot $stamp
    $created = @()
    foreach ($rel in @($changed + $removed)) {
        $dst = Get-LocalPath $Root $rel
        if (Test-Path -LiteralPath $dst) {
            $bak = Get-LocalPath $backupDir $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null
            Copy-Item -LiteralPath $dst -Destination $bak -Force
        } else {
            $created += $rel
        }
    }

    # 反映
    foreach ($rel in $changed) {
        $dst = Get-LocalPath $Root $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
        Copy-Item -LiteralPath (Get-LocalPath $filesDir $rel) -Destination $dst -Force
    }
    foreach ($rel in $removed) { Remove-Item -LiteralPath (Get-LocalPath $Root $rel) -Force }
    $touched = @($changed + $removed)
    Write-Log ("反映: version=$($version.Substring(0,12)) 変更 $($changed.Count) 件 / 削除 $($removed.Count) 件" +
        $(if ($touched.Count -le 20) { ' [' + ($touched -join ', ') + ']' } else { '' }))

    $depsChanged = @($touched | Where-Object { $_ -match $DepsPattern }).Count -gt 0
    $runtimeChanged = $depsChanged -or (@($touched | Where-Object { $_ -match $RuntimePattern }).Count -gt 0)
    if (@($touched | Where-Object { $_ -match $InfraPattern }).Count -gt 0) {
        Write-Log '警告: opensearch\ か docker-compose.yml が変わりました。イメージの再ビルドやインデックスの作り直しは手で行ってください'
    }

    $ok = $true
    try {
        if ($depsChanged) { Invoke-PnpmInstall }
        if ($runtimeChanged) {
            $ok = Restart-Mcp
            Write-Log ("MCP サーバーを再起動: " + $(if ($ok) { '応答あり' } else { '応答なし' }))
        }
    } catch {
        Write-Log "失敗: $($_.Exception.Message)"
        $ok = $false
    }

    if (-not $ok) {
        # 元に戻す
        foreach ($rel in $touched) {
            $bak = Get-LocalPath $backupDir $rel
            if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination (Get-LocalPath $Root $rel) -Force }
        }
        foreach ($rel in $created) { Remove-Item -LiteralPath (Get-LocalPath $Root $rel) -Force -ErrorAction SilentlyContinue }
        try { if ($depsChanged) { Invoke-PnpmInstall } } catch { Write-Log "戻した後の pnpm install も失敗: $($_.Exception.Message)" }
        $back = Restart-Mcp
        New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
        [System.IO.File]::WriteAllText($FailedFile, (@{ version = $version; at = (Get-Date).ToString('o') } | ConvertTo-Json), $Utf8)
        Write-Log ("元に戻しました: MCP " + $(if ($back) { '応答あり' } else { '応答なし' }) + "。version=$($version.Substring(0,12)) は再試行しません")
        exit 1
    }

    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    [System.IO.File]::WriteAllText($DeployedFile, ($manifest | ConvertTo-Json -Depth 5), $Utf8)
    Remove-Item -LiteralPath $FailedFile -Force -ErrorAction SilentlyContinue
    Get-ChildItem $BackupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending |
        Select-Object -Skip $KeepBackups | Remove-Item -Recurse -Force
    Write-Log "完了: version=$($version.Substring(0,12))"
    exit 0
} catch {
    Write-Log "エラー: $($_.Exception.Message)"
    exit 1
}
