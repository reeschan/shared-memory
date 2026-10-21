# Windows のトーストを出す (外部のモジュールを使わず、Windows.UI.Notifications の WinRT を使う)。
# -Url を渡すと、トーストのクリック (と「開く」ボタン) でその URL を既定のブラウザーで開く (activationType="protocol")。
# 使い方:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\notify-toast.ps1 -Title '題' -Body '本文' [-Url 'http://...']
# 終了コード: 0 = 出した / 1 = 出せなかった
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Body = '',
    [string]$Url = ''
)

$ErrorActionPreference = 'Stop'

# 通知の送り主。インストールされた AppUserModelID でないとトーストが出ないので、Windows PowerShell のものを使う
$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

function ConvertTo-XmlText([string]$s) {
    return [System.Security.SecurityElement]::Escape($s)
}

try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

    $titleXml = ConvertTo-XmlText $Title
    $bodyXml = ConvertTo-XmlText $Body
    $launch = ''
    $actions = ''
    if ($Url -ne '') {
        $urlXml = ConvertTo-XmlText $Url
        $launch = " activationType=`"protocol`" launch=`"$urlXml`""
        $actions = "<actions><action content=`"開く`" activationType=`"protocol`" arguments=`"$urlXml`"/></actions>"
    }
    $xml = "<toast$launch><visual><binding template=`"ToastGeneric`"><text>$titleXml</text><text>$bodyXml</text></binding></visual>$actions</toast>"

    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
    exit 0
} catch {
    Write-Error ("トーストを出せませんでした: " + $_.Exception.Message) -ErrorAction Continue
    exit 1
}
