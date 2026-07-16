[CmdletBinding()]
param(
  [string]$NodeVersion = "24.18.0",
  [string]$NodeSha256 = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
  [string]$CloudflaredVersion = "2026.7.1",
  [string]$CloudflaredSha256 = "ccb0756de288d3c2c076d19764ca53e0849a10f2dd9c23f8656ac42bdeb45001",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$tempRoot = Join-Path $root ".tmp\windows-package"
$stageRoot = Join-Path $tempRoot "VibeLink"
$cacheRoot = Join-Path $tempRoot "cache"
$outputRoot = if ($OutputDir) { [IO.Path]::GetFullPath($OutputDir) } else { Join-Path $root "artifacts\windows" }

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") })
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Reset-Directory([string]$Path, [string]$AllowedRoot) {
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $resolvedAllowedRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\') + '\'
  if (-not $resolvedPath.StartsWith($resolvedAllowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset directory outside $resolvedAllowedRoot"
  }
  if (Test-Path -LiteralPath $resolvedPath) {
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
  }
  New-Item -ItemType Directory -Path $resolvedPath -Force | Out-Null
}

New-Item -ItemType Directory -Path $tempRoot, $cacheRoot, $outputRoot -Force | Out-Null
Reset-Directory -Path $stageRoot -AllowedRoot $tempRoot
New-Item -ItemType Directory -Path (Join-Path $stageRoot "runtime") -Force | Out-Null

$publicDir = Join-Path $stageRoot "public"
$viteEntry = Join-Path $root "node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $viteEntry)) { throw "Vite is not installed. Run npm install before packaging." }
Invoke-Checked "node.exe" @($viteEntry, "build", "--outDir", $publicDir, "--emptyOutDir")

$cargoTargetRoot = if ($env:CARGO_TARGET_DIR) {
  if ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
    [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
  } else {
    [IO.Path]::GetFullPath((Join-Path $root $env:CARGO_TARGET_DIR))
  }
} else {
  Join-Path $root "apps\windows\target"
}
$originalCargoTargetDir = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = $cargoTargetRoot
try {
  Invoke-Checked "cargo.exe" @("build", "--release", "--manifest-path", (Join-Path $root "apps\windows\Cargo.toml"))
} finally {
  $env:CARGO_TARGET_DIR = $originalCargoTargetDir
}
Copy-Item -LiteralPath (Join-Path $cargoTargetRoot "release\vibelink.exe") -Destination (Join-Path $stageRoot "vibelink.exe")
Copy-Item -LiteralPath (Join-Path $root "src") -Destination (Join-Path $stageRoot "src") -Recurse
New-Item -ItemType Directory -Path (Join-Path $stageRoot "packages") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "packages\doubao-cli") -Destination (Join-Path $stageRoot "packages\doubao-cli") -Recurse
New-Item -ItemType Directory -Path (Join-Path $stageRoot "tools") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "tools\doubao-cli.mjs") -Destination (Join-Path $stageRoot "tools\doubao-cli.mjs")
Copy-Item -LiteralPath (Join-Path $root "tools\windows\start-public-tunnel.ps1") -Destination (Join-Path $stageRoot "start-public-tunnel.ps1")
New-Item -ItemType Directory -Path (Join-Path $stageRoot "docs") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "docs\openapi.json") -Destination (Join-Path $stageRoot "docs\openapi.json")
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $stageRoot "README.md")

$nodeArchive = Join-Path $cacheRoot "node-v$NodeVersion-win-x64.zip"
if (-not (Test-Path -LiteralPath $nodeArchive)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $nodeArchive
}
if ((Get-Sha256 $nodeArchive) -ne $NodeSha256.ToLowerInvariant()) {
  throw "Node archive SHA256 does not match the pinned release digest."
}
$nodeExtract = Join-Path $tempRoot "node"
Reset-Directory -Path $nodeExtract -AllowedRoot $tempRoot
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
$nodeRoot = Join-Path $nodeExtract "node-v$NodeVersion-win-x64"
Copy-Item -LiteralPath (Join-Path $nodeRoot "node.exe") -Destination (Join-Path $stageRoot "runtime\node.exe")
Copy-Item -LiteralPath (Join-Path $nodeRoot "LICENSE") -Destination (Join-Path $stageRoot "runtime\NODE-LICENSE")

$cloudflaredCache = Join-Path $cacheRoot "cloudflared-$CloudflaredVersion-windows-amd64.exe"
if (-not (Test-Path -LiteralPath $cloudflaredCache)) {
  Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe" -OutFile $cloudflaredCache
}
if ((Get-Sha256 $cloudflaredCache) -ne $CloudflaredSha256.ToLowerInvariant()) {
  throw "cloudflared SHA256 does not match the pinned GitHub release digest."
}
Copy-Item -LiteralPath $cloudflaredCache -Destination (Join-Path $stageRoot "runtime\cloudflared.exe")
$cloudflaredLicense = Join-Path $cacheRoot "cloudflared-$CloudflaredVersion-LICENSE"
if (-not (Test-Path -LiteralPath $cloudflaredLicense)) {
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/cloudflare/cloudflared/$CloudflaredVersion/LICENSE" -OutFile $cloudflaredLicense
}
Copy-Item -LiteralPath $cloudflaredLicense -Destination (Join-Path $stageRoot "runtime\CLOUDFLARED-LICENSE")

$sourcePackage = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$runtimeDependencyNames = @("js-tiktoken", "qrcode", "web-push", "ws", "zod")
$runtimeDependencies = [ordered]@{}
foreach ($name in $runtimeDependencyNames) {
  $property = $sourcePackage.dependencies.PSObject.Properties[$name]
  if (-not $property) { throw "Runtime dependency is missing from package.json: $name" }
  $runtimeDependencies[$name] = $property.Value
}
$runtimePackage = [ordered]@{
  name = "vibelink-runtime"
  version = $sourcePackage.version
  private = $true
  type = "module"
  engines = @{ node = ">=22.5.0" }
  dependencies = $runtimeDependencies
}
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "package.json"),
  (($runtimePackage | ConvertTo-Json -Depth 5) + "`n"),
  (New-Object Text.UTF8Encoding($false))
)
Push-Location $stageRoot
try {
  Invoke-Checked "npm.cmd" @("install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false")
} finally {
  Pop-Location
}

$commit = (git -C $root rev-parse HEAD).Trim()
$manifest = [ordered]@{
  product = "VibeLink"
  version = $sourcePackage.version
  commit = $commit
  node = $NodeVersion
  cloudflared = $CloudflaredVersion
  builtAt = [DateTime]::UtcNow.ToString("o")
  entry = "vibelink.exe"
}
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "release-manifest.json"),
  (($manifest | ConvertTo-Json -Depth 3) + "`n"),
  (New-Object Text.UTF8Encoding($false))
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-status-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-doctor-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http --rust-doctor-http %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-devices-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http --rust-doctor-http --rust-devices-http %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-device-mutations-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http --rust-doctor-http --rust-devices-http --rust-device-mutations-http %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-pairing-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http --rust-doctor-http --rust-devices-http --rust-device-mutations-http --rust-pairing-http %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-audit-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http --rust-doctor-http --rust-devices-http --rust-device-mutations-http --rust-pairing-http --rust-audit-http %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-settings-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http --rust-doctor-http --rust-devices-http --rust-device-mutations-http --rust-pairing-http --rust-audit-http --rust-settings-http %*`r`n",
  [Text.Encoding]::ASCII
)
[IO.File]::WriteAllText(
  (Join-Path $stageRoot "start-vibelink-tool-events-http-canary.cmd"),
  "@echo off`r`ncd /d %~dp0`r`nvibelink.exe --rust-canary --rust-http-canary --rust-status-http --rust-doctor-http --rust-devices-http --rust-device-mutations-http --rust-pairing-http --rust-audit-http --rust-settings-http --rust-tool-events-http %*`r`n",
  [Text.Encoding]::ASCII
)

$archive = Join-Path $outputRoot "VibeLink-$($sourcePackage.version)-windows-x64.zip"
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -LiteralPath $stageRoot -DestinationPath $archive -CompressionLevel Optimal
$hash = Get-Sha256 $archive
[IO.File]::WriteAllText("$archive.sha256", "$hash  $([IO.Path]::GetFileName($archive))`n", [Text.Encoding]::ASCII)

[pscustomobject]@{
  archive = $archive
  sha256 = $hash
  sizeBytes = (Get-Item -LiteralPath $archive).Length
  stage = $stageRoot
} | ConvertTo-Json -Compress
