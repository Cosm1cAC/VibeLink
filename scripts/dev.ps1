<#
.SYNOPSIS
    Launch the VibeLink v3 unified control-plane server and frontend client for local development.
.DESCRIPTION
    Starts server/ (port 18990 by default) and client/ (port 6130 by default or native Tauri desktop with -Tauri).
    Leaves host proxy and mesh services (WProxy, opencode-mesh, rshell, keys) untouched.
#>
[CmdletBinding()]
param(
    [int]$ServerPort = 18990,
    [int]$ClientPort = 6130,
    [string]$ServerHost = '127.0.0.1',
    [switch]$MockBots,
    [switch]$Tauri
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverAppDir = Join-Path $repoRoot 'server\apps\server'
$clientDir = Join-Path $repoRoot 'client'

if (-not (Test-Path (Join-Path $serverAppDir 'src\bin.ts'))) {
    throw "VibeLink server entrypoint not found under $serverAppDir"
}
if (-not (Test-Path (Join-Path $clientDir 'package.json'))) {
    throw "VibeLink client workspace not found under $clientDir"
}

$serverProc = $null
$clientProc = $null

$previousMockEnv = $env:VIBELINK_MOCK_BOTS
$previousServerUrlEnv = $env:VITE_VIBELINK_SERVER_URL

try {
    if ($MockBots) {
        $env:VIBELINK_MOCK_BOTS = '1'
        Write-Host '[VibeLink] VIBELINK_MOCK_BOTS=1 enabled (offline mock Bot handoffs active).' -ForegroundColor Cyan
    }

    $env:VITE_VIBELINK_SERVER_URL = "http://${ServerHost}:${ServerPort}"

    Write-Host "[VibeLink] Starting control-plane server at http://${ServerHost}:${ServerPort} ..." -ForegroundColor Green
    $serverProc = Start-Process -FilePath 'node' `
        -ArgumentList @('src/bin.ts', 'serve', '--mode', 'desktop', '--host', $ServerHost, '--port', "$ServerPort") `
        -WorkingDirectory $serverAppDir `
        -PassThru `
        -NoNewWindow

    $healthUrl = "http://${ServerHost}:${ServerPort}/api/vl/health"
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        if ($serverProc.HasExited) {
            throw "VibeLink server exited early with code $($serverProc.ExitCode)"
        }
        try {
            $resp = Invoke-WebRequest -Uri $healthUrl -Method GET -TimeoutSec 2 -UseBasicParsing
            if ($resp.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }

    if (-not $ready) {
        Write-Warning "[VibeLink] Health endpoint $healthUrl did not answer in time; continuing client launch."
    } else {
        Write-Host "[VibeLink] Control-plane healthy ($healthUrl)." -ForegroundColor Green
    }

    if ($Tauri) {
        Write-Host '[VibeLink] Starting Tauri desktop shell (pnpm tauri dev)...' -ForegroundColor Green
        $clientProc = Start-Process -FilePath 'pnpm.cmd' `
            -ArgumentList @('--dir', $clientDir, 'tauri', 'dev') `
            -WorkingDirectory $clientDir `
            -PassThru `
            -NoNewWindow
    } else {
        Write-Host "[VibeLink] Starting Vite client at http://127.0.0.1:${ClientPort} ..." -ForegroundColor Green
        $clientProc = Start-Process -FilePath 'pnpm.cmd' `
            -ArgumentList @('--dir', $clientDir, 'dev', '--host', '127.0.0.1', '--port', "$ClientPort") `
            -WorkingDirectory $clientDir `
            -PassThru `
            -NoNewWindow
    }

    Write-Host '[VibeLink] Press Ctrl+C to stop both processes cleanly.' -ForegroundColor Yellow
    while ($true) {
        if ($serverProc -and $serverProc.HasExited) {
            Write-Warning "[VibeLink] Server exited with code $($serverProc.ExitCode)."
            break
        }
        if ($clientProc -and $clientProc.HasExited) {
            Write-Host "[VibeLink] Client exited with code $($clientProc.ExitCode)."
            break
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    if ($null -eq $previousMockEnv) {
        Remove-Item Env:VIBELINK_MOCK_BOTS -ErrorAction SilentlyContinue
    } else {
        $env:VIBELINK_MOCK_BOTS = $previousMockEnv
    }
    if ($null -eq $previousServerUrlEnv) {
        Remove-Item Env:VITE_VIBELINK_SERVER_URL -ErrorAction SilentlyContinue
    } else {
        $env:VITE_VIBELINK_SERVER_URL = $previousServerUrlEnv
    }

    foreach ($proc in @($clientProc, $serverProc)) {
        if ($proc -and -not $proc.HasExited) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
                # Ignore already exited child process
            }
        }
    }
    Write-Host '[VibeLink] Dev session stopped cleanly.' -ForegroundColor Cyan
}
