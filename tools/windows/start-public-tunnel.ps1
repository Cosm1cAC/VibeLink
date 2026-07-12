[CmdletBinding()]
param(
  [string]$AppRoot = "",
  [string]$SettingsPath = "",
  [string]$ConfigPath = "$HOME\.cloudflared\config.yml",
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
if (-not $AppRoot) {
  $AppRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "vibelink.exe")) {
    $PSScriptRoot
  } else {
    (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  }
}
$AppRoot = [IO.Path]::GetFullPath($AppRoot)
$launcher = Join-Path $AppRoot "vibelink.exe"
if (-not (Test-Path -LiteralPath $launcher)) {
  $launcher = Join-Path $AppRoot "apps\windows\target\release\vibelink.exe"
}
if (-not (Test-Path -LiteralPath $launcher)) { throw "vibelink.exe is unavailable under $AppRoot" }

$arguments = @("tunnel", "--config", [IO.Path]::GetFullPath($ConfigPath))
if ($SettingsPath) { $arguments += @("--settings", [IO.Path]::GetFullPath($SettingsPath)) }
if ($CheckOnly) { $arguments += "--check-only" }
& $launcher @arguments
exit $LASTEXITCODE
