# TypeScript を直接実行できる Node を探す関数。start-mcp.ps1・register-tasks.ps1・remote-eval.ps1 から
# ドットソース (. $PSScriptRoot\node-path.ps1) で読み込む。

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
# タスクスケジューラや SSH から起動すると fnm の環境が無く、PATH の node が古い版になることがあるため、
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
