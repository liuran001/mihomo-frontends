#Requires -Version 7.0
[CmdletBinding()]
param([switch]$SkipWebUiBuild)

$ErrorActionPreference = 'Stop'
$moduleRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $moduleRoot '..'))
$webUiRoot = Join-Path $moduleRoot 'webui'
$webDist = Join-Path $webUiRoot 'build/dist/wasmJs/productionExecutable'
$dist = Join-Path $repoRoot 'dist'

function Get-PackageFiles([string]$Root) {
    $directory = Get-Item -LiteralPath $Root -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "打包源必须是普通目录：$Root"
    }
    $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
    if ($items | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }) {
        throw "打包源不能包含符号链接或联接点：$Root"
    }
    $items | Where-Object { -not $_.PSIsContainer }
}

function Assert-DistFile([string]$Path) {
    $absolute = [System.IO.Path]::GetFullPath($Path)
    $comparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    $prefix = $dist + [System.IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, $comparison) -or
        -not [System.IO.Path]::GetDirectoryName($absolute).Equals($dist, $comparison)) {
        throw "拒绝操作根 dist 之外的文件：$absolute"
    }
    $directory = Get-Item -LiteralPath $dist -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "dist 必须是普通目录：$dist"
    }
    if (Test-Path -LiteralPath $absolute) {
        $item = Get-Item -LiteralPath $absolute -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "拒绝覆盖或删除目录、符号链接或联接点：$absolute"
        }
    }
}

function Add-PackageFile($Archive, [System.IO.FileInfo]$File, [string]$EntryName, [bool]$NormalizeText) {
    $entry = $Archive.CreateEntry($EntryName)
    $target = $entry.Open()
    try {
        if ($NormalizeText) {
            $writer = [System.IO.StreamWriter]::new($target, [System.Text.UTF8Encoding]::new($false))
            try { $writer.Write([System.IO.File]::ReadAllText($File.FullName).Replace("`r`n", "`n")) }
            finally { $writer.Dispose() }
        } else {
            $source = [System.IO.File]::OpenRead($File.FullName)
            try { $source.CopyTo($target) }
            finally { $source.Dispose() }
        }
    } finally { $target.Dispose() }
}

$properties = @{}
Get-Content -LiteralPath (Join-Path $moduleRoot 'module.prop') | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { $properties[$Matches[1]] = $Matches[2] }
}
foreach ($name in @('id', 'version')) {
    if ($properties[$name] -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._+-]*\z') {
        throw "module.prop 的 $name 缺失或不适合用作文件名"
    }
}

if (-not $SkipWebUiBuild) {
    Push-Location -LiteralPath $webUiRoot
    try {
        if ($IsWindows) {
            & (Join-Path $webUiRoot 'gradlew.bat') --no-daemon wasmJsBrowserDistribution
        } else {
            & sh ./gradlew --no-daemon wasmJsBrowserDistribution
        }
        if ($LASTEXITCODE -ne 0) { throw "WebUI Gradle 构建失败，退出码：$LASTEXITCODE" }
    } finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath $webDist -PathType Container)) {
    throw "缺少 WebUI 产物：$webDist；请先构建 wasmJsBrowserDistribution"
}
$webFiles = @(Get-PackageFiles $webDist)
foreach ($name in @('index.html', 'mihomo.js', 'bootstrap.js', 'backend.js', 'config.js', 'vendor/yaml.min.js', 'vendor/YAML-LICENSE.txt', 'vendor/qrcode.js', 'vendor/QRCODE-LICENSE.txt', 'template.yaml', 'FONT-LICENSE.txt')) {
    $required = Get-Item -LiteralPath (Join-Path $webDist $name) -Force
    if ($required.PSIsContainer -or $required.Length -eq 0) { throw "WebUI 产物缺失或为空：$name" }
}
$wasmFiles = @($webFiles | Where-Object { $_.Extension -eq '.wasm' })
$fonts = @($webFiles | Where-Object { $_.Name -eq 'noto_sans_sc.otf' -and $_.Length -gt 0 })
if ($fonts.Count -eq 0) { throw 'WebUI 产物缺少离线中文字体；拒绝打包' }
if ($wasmFiles.Count -eq 0 -or (@($wasmFiles | Where-Object { $_.Length -eq 0 }).Count -gt 0)) {
    throw 'WebUI 产物缺少非空 wasm；拒绝打包旧 webroot'
}

# 网页管理服务：静态链接的 Linux 程序，Android 上可直接运行；customize.sh 按 ARCH 保留其一
$webdRoot = Join-Path $moduleRoot 'webd'
$webdOut = Join-Path $webdRoot 'out'
$webdFiles = @()
$screenAssets = Join-Path $moduleRoot 'scrcpy-assets/out'
Push-Location -LiteralPath $webdRoot
try {
    & go run . assets -data $screenAssets
    if ($LASTEXITCODE -ne 0) { throw '内置屏幕资源下载或校验失败' }
} finally { Pop-Location }
foreach ($name in @('scrcpy-server-v5.0.1.jar', 'jmuxer.min.js')) {
    $webdFiles += @{ File = (Get-Item -LiteralPath (Join-Path $screenAssets $name)); Entry = "bin/scrcpy/$name" }
}
# 第三方许可合并成模块根目录下的一个文件，不再分散在各目录
$licenseParts = @(
    @('mihomo-webd 的 Go 依赖', (Join-Path $webdRoot 'THIRD-PARTY-NOTICES.txt')),
    @('Noto Sans CJK（界面字体子集）', (Join-Path $webDist 'FONT-LICENSE.txt')),
    @('yaml', (Join-Path $webDist 'vendor/YAML-LICENSE.txt')),
    @('qrcode', (Join-Path $webDist 'vendor/QRCODE-LICENSE.txt')),
    @('scrcpy server 5.0.1', (Join-Path $screenAssets 'SCRCPY-LICENSE.txt')),
    @('JMuxer 2.1.4', (Join-Path $screenAssets 'JMUXER-LICENSE.txt'))
)
$licenseText = ($licenseParts | ForEach-Object {
    "==================== $($_[0]) ====================`n`n" + ([System.IO.File]::ReadAllText($_[1]) -replace "`r", '') + "`n`n"
}) -join ''
New-Item -ItemType Directory -Force -Path $webdOut | Out-Null
$licenseFile = Join-Path $webdOut 'THIRD-PARTY-LICENSES.txt'
[System.IO.File]::WriteAllText($licenseFile, $licenseText, [System.Text.UTF8Encoding]::new($false))
$webdFiles += @{ File = (Get-Item -LiteralPath $licenseFile); Entry = 'THIRD-PARTY-LICENSES.txt' }
foreach ($target in @(@{ Arch = 'arm64'; GoArch = 'arm64' }, @{ Arch = 'x64'; GoArch = 'amd64' }, @{ Arch = 'arm'; GoArch = 'arm' })) {
    $binary = Join-Path $webdOut "$($target.Arch)/mihomo-webd"
    Push-Location -LiteralPath $webdRoot
    $saved = @{ GOOS = $env:GOOS; GOARCH = $env:GOARCH; GOARM = $env:GOARM; CGO_ENABLED = $env:CGO_ENABLED }
    try {
        $env:GOOS = 'linux'; $env:GOARCH = $target.GoArch; $env:GOARM = '7'; $env:CGO_ENABLED = '0'
        & go build -trimpath -ldflags '-s -w' -o $binary .
        if ($LASTEXITCODE -ne 0) { throw "mihomo-webd 构建失败（$($target.Arch)），退出码：$LASTEXITCODE" }
    } finally {
        foreach ($name in $saved.Keys) { Set-Item -Path "env:$name" -Value $saved[$name] }
        Pop-Location
    }
    $webdFiles += @{ File = (Get-Item -LiteralPath $binary); Entry = "bin/$($target.Arch)/mihomo-webd" }
}

if ($IsWindows) {
    & (Join-Path $moduleRoot 'device-helper/build.ps1')
} else {
    & sh (Join-Path $moduleRoot 'device-helper/build.sh')
    if ($LASTEXITCODE -ne 0) { throw '设备控制桥接构建失败' }
}
$webdFiles += @{ File = (Get-Item -LiteralPath (Join-Path $moduleRoot 'device-helper/out/device-control.jar')); Entry = 'bin/device-control.jar' }

$moduleFiles = @('module.prop', 'customize.sh', 'service.sh', 'post-fs-data.sh') |
    ForEach-Object { Get-Item -LiteralPath (Join-Path $moduleRoot $_) -Force }
$moduleFiles += @(Get-PackageFiles (Join-Path $moduleRoot 'scripts'))
foreach ($file in $moduleFiles) {
    if ($file.PSIsContainer -or ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "模块文件必须是普通文件：$($file.FullName)"
    }
}

if (-not (Test-Path -LiteralPath $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
$output = Join-Path $dist "$($properties.id)-magisk-$($properties.version).zip"
$temporaryOutput = Join-Path $dist ('.magisk-' + [guid]::NewGuid().ToString('N') + '.zip')
Assert-DistFile $output
Assert-DistFile $temporaryOutput
try {
    $archive = [System.IO.Compression.ZipFile]::Open($temporaryOutput, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $moduleFiles) {
            $relative = [System.IO.Path]::GetRelativePath($moduleRoot, $file.FullName).Replace('\', '/')
            $normalize = $relative -eq 'module.prop' -or $file.Extension -in @('.sh', '.awk')
            Add-PackageFile $archive $file $relative $normalize
        }
        # 网页资源只打包原文件：gzip 副本由 customize.sh 安装时生成（避免安装包里同一份资源存两遍）；
        # source map 只用于调试，不打包
        foreach ($file in $webFiles) {
            if ($file.Extension -eq '.map') { continue }
            $relative = [System.IO.Path]::GetRelativePath($webDist, $file.FullName).Replace('\', '/')
            # 许可文本已合并进 THIRD-PARTY-LICENSES.txt
            if ($relative -in @('FONT-LICENSE.txt', 'vendor/YAML-LICENSE.txt', 'vendor/QRCODE-LICENSE.txt')) { continue }
            Add-PackageFile $archive $file "webroot/$relative" $false
        }
        foreach ($item in $webdFiles) { Add-PackageFile $archive $item.File $item.Entry $false }
    } finally { $archive.Dispose() }
    Assert-DistFile $temporaryOutput
    Assert-DistFile $output
    Move-Item -LiteralPath $temporaryOutput -Destination $output -Force
} finally {
    if (Test-Path -LiteralPath $temporaryOutput) {
        Assert-DistFile $temporaryOutput
        Remove-Item -LiteralPath $temporaryOutput -Force
    }
}
Write-Output "已生成 $output"
