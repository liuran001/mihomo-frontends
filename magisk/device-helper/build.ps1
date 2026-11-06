param([string]$Output = (Join-Path $PSScriptRoot 'out'))
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
if (-not $sdk) { throw '需要 ANDROID_HOME 构建设备控制桥接' }
$platform = Get-ChildItem (Join-Path $sdk 'platforms/*/android.jar') | Sort-Object FullName | Select-Object -Last 1
$compiler = Get-ChildItem (Join-Path $sdk 'build-tools/*/d8.bat') | Sort-Object FullName | Select-Object -Last 1
if (-not $platform -or -not $compiler) { throw '缺少 Android SDK Platform (API 30+) 或 Build Tools' }
$javaCompiler = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/javac.exe' } else { 'javac.exe' }
$javaArchive = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/jar.exe' } else { 'jar.exe' }
$classes = Join-Path $Output 'classes'
New-Item -ItemType Directory -Force $classes | Out-Null
& $javaCompiler --release 8 -encoding UTF-8 -classpath $platform.FullName -d $classes (Join-Path $PSScriptRoot 'src/DeviceControl.java')
if ($LASTEXITCODE -ne 0) { throw '设备控制 Java 编译失败' }
& $javaArchive cf (Join-Path $Output 'input.jar') -C $classes .
if ($LASTEXITCODE -ne 0) { throw '设备控制 Java 打包失败' }
& $compiler.FullName --release --min-api 30 --lib $platform.FullName --output $Output (Join-Path $Output 'input.jar')
if ($LASTEXITCODE -ne 0) { throw '设备控制 DEX 编译失败' }
& $javaArchive cf (Join-Path $Output 'device-control.jar') -C $Output classes.dex
if ($LASTEXITCODE -ne 0) { throw '设备控制 DEX 打包失败' }
