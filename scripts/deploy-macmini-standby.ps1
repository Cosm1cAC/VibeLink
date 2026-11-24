[CmdletBinding()]
param(
  [string]$SshHost = $env:VIBELINK_MACMINI_SSH,
  [string]$PrimaryTailscaleUrl = $env:VIBELINK_PRIMARY_TAILSCALE_URL,
  [string]$StandbyTailscaleUrl = $env:VIBELINK_STANDBY_TAILSCALE_URL
)

$ErrorActionPreference = "Stop"

$serverSrcDir = Join-Path (Split-Path -Parent $PSScriptRoot) "server\apps\server\src\vibelink"
$localHome = Join-Path $env:USERPROFILE ".vibelink"
$authTokenPath = Join-Path $localHome "auth-token.txt"
$localClusterPath = Join-Path $localHome "cluster-config.json"

if (-not (Test-Path $authTokenPath)) {
  throw "Missing PC auth-token at $authTokenPath. Start PC VibeLink server once first."
}
New-Item -ItemType Directory -Force -Path $localHome | Out-Null

$existing = @{}
if (Test-Path $localClusterPath) {
  try {
    $parsed = Get-Content $localClusterPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $parsed.PSObject.Properties) {
      $existing[$p.Name] = $p.Value
    }
  } catch {
    $existing = @{}
  }
}

$sshHost = if ($SshHost -and $SshHost.Trim()) {
  $SshHost.Trim()
} elseif ($existing["standbySshHost"] -and $existing["standbySshHost"].ToString().Trim()) {
  $existing["standbySshHost"].ToString().Trim()
} else {
  throw "Missing SSH target. Pass -SshHost <ssh-host> or set VIBELINK_MACMINI_SSH (or standbySshHost in ~/.vibelink/cluster-config.json)."
}

$clusterSecret = if ($existing["clusterSecret"] -and ($existing["clusterSecret"].ToString().Length -ge 16)) {
  $existing["clusterSecret"].ToString()
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
}

$primaryPublicUrl = if ($existing["primaryPublicUrl"]) { $existing["primaryPublicUrl"].ToString() } else { "" }
$standbyPublicUrl = if ($existing["standbyPublicUrl"]) { $existing["standbyPublicUrl"].ToString() } else { "" }
$primaryTsUrl = if ($PrimaryTailscaleUrl -and $PrimaryTailscaleUrl.Trim()) {
  $PrimaryTailscaleUrl.Trim().TrimEnd('/')
} elseif ($existing["primaryTailscaleUrl"] -and $existing["primaryTailscaleUrl"].ToString().Trim()) {
  $existing["primaryTailscaleUrl"].ToString().Trim().TrimEnd('/')
} else {
  throw "Missing Primary Tailscale URL. Pass -PrimaryTailscaleUrl http://<tailscale-ip>:18990 or set VIBELINK_PRIMARY_TAILSCALE_URL / primaryTailscaleUrl in ~/.vibelink/cluster-config.json."
}
$standbyTsUrl = if ($StandbyTailscaleUrl -and $StandbyTailscaleUrl.Trim()) {
  $StandbyTailscaleUrl.Trim().TrimEnd('/')
} elseif ($existing["standbyTailscaleUrl"] -and $existing["standbyTailscaleUrl"].ToString().Trim()) {
  $existing["standbyTailscaleUrl"].ToString().Trim().TrimEnd('/')
} else {
  throw "Missing Standby Tailscale URL. Pass -StandbyTailscaleUrl http://<tailscale-ip>:18990 or set VIBELINK_STANDBY_TAILSCALE_URL / standbyTailscaleUrl in ~/.vibelink/cluster-config.json."
}
$syncIntervalMs = if ($existing["syncIntervalMs"]) { [int]$existing["syncIntervalMs"] } else { 30000 }

$primaryConfig = [ordered]@{
  role                = "primary"
  nodeId              = "pc-primary"
  nodeLabel           = "本机 PC 主服"
  peerUrl             = $standbyTsUrl
  primaryTailscaleUrl = $primaryTsUrl
  primaryPublicUrl    = $primaryPublicUrl
  standbyTailscaleUrl = $standbyTsUrl
  standbyPublicUrl    = $standbyPublicUrl
  clusterSecret       = $clusterSecret
  syncIntervalMs      = $syncIntervalMs
}

$standbyConfig = [ordered]@{
  role                = "standby"
  nodeId              = "macmini-standby"
  nodeLabel           = "Mac mini 备服"
  peerUrl             = $primaryTsUrl
  primaryTailscaleUrl = $primaryTsUrl
  primaryPublicUrl    = $primaryPublicUrl
  standbyTailscaleUrl = $standbyTsUrl
  standbyPublicUrl    = $standbyPublicUrl
  clusterSecret       = $clusterSecret
  syncIntervalMs      = $syncIntervalMs
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($localClusterPath, (($primaryConfig | ConvertTo-Json -Depth 4) + "`n"), $utf8NoBom)

$tmpStage = Join-Path $env:TEMP ("vl-macmini-stage-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmpStage | Out-Null

try {
  $appStage = Join-Path $tmpStage "app"
  $cfgStage = Join-Path $tmpStage "cfg"
  New-Item -ItemType Directory -Force -Path $appStage, $cfgStage | Out-Null

  $standbyPkgPath = Join-Path $appStage "package.json"
  $standbyClusterPath = Join-Path $cfgStage "cluster-config.json"
  $standbyTokenPath = Join-Path $cfgStage "auth-token.txt"
  $plistPath = Join-Path $tmpStage "com.vibelink.standby.plist"

  [System.IO.File]::WriteAllText($standbyPkgPath, "{`"name`": `"vibelink-standby`", `"private`": true, `"type`": `"module`"}`n", $utf8NoBom)
  [System.IO.File]::WriteAllText($standbyClusterPath, (($standbyConfig | ConvertTo-Json -Depth 4) + "`n"), $utf8NoBom)
  Copy-Item $authTokenPath $standbyTokenPath -Force

  $tsNames = @(
    "standbyServer.ts",
    "accountRoutes.ts",
    "accounts.ts",
    "cluster.ts",
    "gateway.ts",
    "db.ts",
    "auth.ts",
    "pairing.ts",
    "types.ts"
  )
  foreach ($f in $tsNames) {
    Copy-Item (Join-Path $serverSrcDir $f) (Join-Path $appStage $f) -Force
  }

  Write-Output "[deploy] Resolving remote `$HOME and creating directories on $sshHost..."
  $remoteHome = (& ssh -o BatchMode=yes -o ConnectTimeout=10 $sshHost 'mkdir -p ~/vibelink-standby ~/.vibelink ~/Library/LaunchAgents && printf "%s" "$HOME"').Trim()
  if ($LASTEXITCODE -ne 0 -or -not $remoteHome) { throw "SSH directory init failed" }

  $plistContent = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vibelink.standby</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$remoteHome/vibelink-standby/standbyServer.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$remoteHome/vibelink-standby</string>
  <key>LimitLoadToSessionType</key>
  <string>Background</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:$remoteHome/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>VIBELINK_HOST</key>
    <string>0.0.0.0</string>
    <key>VIBELINK_PORT</key>
    <string>18990</string>
    <key>VIBELINK_CLUSTER_ROLE</key>
    <string>standby</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$remoteHome/vibelink-standby/standby.log</string>
  <key>StandardErrorPath</key>
  <string>$remoteHome/vibelink-standby/standby.err.log</string>
</dict>
</plist>
"@
  [System.IO.File]::WriteAllText($plistPath, $plistContent, $utf8NoBom)

  Write-Output "[deploy] Uploading compressed bundle to $sshHost via MTU-safe SSH stream..."
  $nodeUploadScript = @'
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

const [sshHost, appStage, cfgStage, plistPath] = process.argv.slice(2);
const readDirMap = (dir) => {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    out[name] = fs.readFileSync(path.join(dir, name), "utf8");
  }
  return out;
};
const bundle = {
  app: readDirMap(appStage),
  cfg: readDirMap(cfgStage),
  plist: fs.readFileSync(plistPath, "utf8")
};
const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), "utf8")).toString("base64");
const remoteScript = [
  "const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),os=require('node:os');",
  "const home=os.homedir();",
  "const b64=fs.readFileSync(0,'utf8').trim();",
  "const data=JSON.parse(zlib.gunzipSync(Buffer.from(b64,'base64')).toString('utf8'));",
  "for(const [k,v] of Object.entries(data.app)){fs.writeFileSync(path.join(home,'vibelink-standby',k),v,'utf8');}",
  "for(const [k,v] of Object.entries(data.cfg)){fs.writeFileSync(path.join(home,'.vibelink',k),v,{encoding:'utf8',mode:0o600});}",
  "fs.writeFileSync(path.join(home,'Library','LaunchAgents','com.vibelink.standby.plist'),data.plist,'utf8');",
  "console.log('UPLOADED_FILES=' + Object.keys(data.app).length + ' B64_LEN=' + b64.length);"
].join("");

const child = spawn("ssh", [
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "IPQoS=throughput",
  sshHost,
  `/opt/homebrew/bin/node -e "${remoteScript}"`
], { stdio: ["pipe", "inherit", "inherit"] });

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});

(async () => {
  const CHUNK = 900;
  for (let i = 0; i < b64.length; i += CHUNK) {
    child.stdin.write(b64.slice(i, i + CHUNK));
    await new Promise((r) => setTimeout(r, 15));
  }
  child.stdin.end("\n");
})();
'@
  $uploadJsPath = Join-Path $tmpStage "upload.cjs"
  [System.IO.File]::WriteAllText($uploadJsPath, $nodeUploadScript, $utf8NoBom)
  & node $uploadJsPath $sshHost $appStage $cfgStage $plistPath
  if ($LASTEXITCODE -ne 0) { throw "SSH bundle upload failed" }

  Write-Output "[deploy] Starting LaunchAgent com.vibelink.standby on $sshHost..."
  $remoteCmd = @'
chmod 600 ~/.vibelink/auth-token.txt ~/.vibelink/cluster-config.json
UID_NUM=$(id -u)
launchctl bootout user/$UID_NUM/com.vibelink.standby 2>/dev/null || true
launchctl bootout user/$UID_NUM ~/Library/LaunchAgents/com.vibelink.standby.plist 2>/dev/null || true
sleep 1
if ! launchctl bootstrap user/$UID_NUM ~/Library/LaunchAgents/com.vibelink.standby.plist 2>/dev/null; then
  launchctl unload -w ~/Library/LaunchAgents/com.vibelink.standby.plist 2>/dev/null || true
  launchctl load -w ~/Library/LaunchAgents/com.vibelink.standby.plist
fi
launchctl kickstart -k user/$UID_NUM/com.vibelink.standby 2>/dev/null || true
'@
  $remoteCmdOneLine = ($remoteCmd -split "\r?\n" | Where-Object { $_.Trim() -ne "" }) -join "; "
  & ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $sshHost $remoteCmdOneLine
  if ($LASTEXITCODE -ne 0) { throw "LaunchAgent start failed" }

  Start-Sleep -Seconds 2
  $healthRaw = & curl.exe --noproxy "*" -fsS --max-time 8 "$standbyTsUrl/api/vl/health"
  if ($LASTEXITCODE -ne 0) { throw "Standby health probe failed for $standbyTsUrl/api/vl/health (check Mac mini socketfilterfw firewall if timeout)" }
  Write-Output ("[deploy] Standby health OK: " + ($healthRaw -join ""))
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpStage
}
