# MCP を SSH 先で動かす構成で、毎週の評価と判定の画面づくりを SSH 先で動かし、トーストは手元の PC に出す。
# 検索ログ・評価セット・判定のセッションはすべて SSH 先にあるので、eval と feedback は SSH 先で動かす。
# 判定の画面の URL (http://127.0.0.1:<mcp.port>/feedback/...) は、手元の SSH のポート転送で開ける。
# 使い方 (手元の PC で。定期タスクは register-tasks.ps1 -RemoteEval で登録する):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\remote-eval.ps1 -Ssh <user>@<server> -RemoteRoot C:/Users/<user>/dev/shared-memory
# 判定の画面の URL には合言葉が入るので、トーストを出せたときは標準出力 (= タスクのログ) に URL を出さない。
# 終了コード: eval の終了コード (eval が失敗しても feedback は動かす)。SSH や feedback が失敗したら 1
param(
    [Parameter(Mandatory = $true)][string]$Ssh,
    [Parameter(Mandatory = $true)][string]$RemoteRoot,
    [int]$Days = 7
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Toast = Join-Path $PSScriptRoot 'notify-toast.ps1'

# SSH 先の PowerShell でコマンドを動かす。引用符の入れ子を避けるため -EncodedCommand で渡す
function Invoke-Remote([string]$cliArgs) {
    $root = $RemoteRoot.Replace("'", "''")
    # 進み具合の表示 (CLIXML) が標準エラーに混ざらないよう、ProgressPreference を止める
    $script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `$ErrorActionPreference = 'Stop'; `$ProgressPreference = 'SilentlyContinue'; " +
        "Set-Location -LiteralPath '$root'; . .\scripts\node-path.ps1; `$node = Get-TsNodePath; " +
        "if (-not `$node) { [Console]::Error.WriteLine('Node 24 以上が見つかりません'); exit 1 }; " +
        "& `$node packages\indexer\src\cli.ts $cliArgs; exit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
    # 呼び出し側が 2>&1 で受けると、Windows PowerShell 5.1 は標準エラーの行を ErrorRecord にし、
    # Stop の下では止まってしまう。ここでは Continue にして、標準出力と標準エラーを分けて受け取る
    $ErrorActionPreference = 'Continue'
    $lines = & ssh.exe -o BatchMode=yes -o ConnectTimeout=20 $Ssh "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" 2>&1
    $code = $LASTEXITCODE
    $out = @($lines | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    $err = @($lines | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.Exception.Message })
    return @{ Code = $code; Out = ($out -join "`n"); Err = ($err -join "`n") }
}

function Send-Toast([string]$title, [string]$body, [string]$url = '') {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Toast, '-Title', $title, '-Body', $body)
    if ($url -ne '') { $a += @('-Url', $url) }
    & powershell.exe @a | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# ---- 評価 ----
$eval = Invoke-Remote 'eval'
Write-Output "eval (終了コード $($eval.Code)):"
Write-Output $eval.Out
Write-Output $eval.Err
$evalCode = $eval.Code

# ---- 判定の画面 ----
$fb = Invoke-Remote "feedback --json --no-open --days $Days"
# rerank の 429 などの警告は、同じ行が何十回も出るので、種類ごとに 1 回だけ残す
if ($fb.Err -ne '') {
    Write-Output 'feedback の警告:'
    Write-Output (($fb.Err -split "`n") | Where-Object { $_.Trim() -ne '' } | Group-Object | ForEach-Object { "$($_.Name) (x$($_.Count))" })
}
if ($fb.Code -ne 0) {
    Write-Output "feedback が失敗しました (終了コード $($fb.Code)):"
    Write-Output $fb.Out
    Send-Toast 'shared-memory: 今週の検索の判定' "判定の画面を作れませんでした (SSH 先: $Ssh)。タスク SharedMemory-Eval のログを見てください" | Out-Null
    exit 1
}
# 標準出力は --json の JSON だけ (警告は標準エラーに出る)
$r = $fb.Out | ConvertFrom-Json
if ($r.status -ne 'created') {
    Write-Output "feedback: $($r.message)"
    exit $evalCode
}

$n = [int]$r.questions
$minutes = [Math]::Max(1, [Math]::Round($n / 2))
$body = "今週の検索結果が役に立ったか、$n 問の判定をお願いします (約 $minutes 分)。クリックで画面を開きます"
if (Send-Toast 'shared-memory: 今週の検索の判定' $body $r.url) {
    Write-Output "トーストで知らせました (セッション $($r.session_id)、問い $n 件)"
} else {
    Write-Output "トーストを出せませんでした。セッション $($r.session_id) (問い $n 件): $($r.url)"
}
exit $evalCode
