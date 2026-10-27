# Starts Cutline and the public link when you sign in. Safe to run again: if they are already up, it leaves them alone.
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;" + $env:Path
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
$log = Join-Path $root 'data\live-server.log'
$urlFile = Join-Path $root 'data\live-url.txt'
$pnpm = Join-Path $env:APPDATA 'npm\pnpm.cmd'
$ngrok = 'C:\Program Files (x86)\ngrok\ngrok.exe'
if (-not (Test-Path $ngrok)) {
  $found = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($found) { $ngrok = $found.Source }
}

function Test-Listen([int]$Port) {
  $pattern = ":$Port\s+.*LISTENING"
  return [bool](netstat -ano | Select-String -Pattern $pattern)
}

if (-not (Test-Listen 3001)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$pnpm`" exec next dev --port 3001 >> `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 45; $i++) {
    if (Test-Listen 3001) { break }
    Start-Sleep -Seconds 2
  }
}

if (-not (Get-Process ngrok -ErrorAction SilentlyContinue)) {
  if (-not (Test-Path $ngrok)) {
    Set-Content -Path $urlFile -Value 'ngrok was not found. Install it, then sign in again.'
    exit 1
  }
  Start-Process -FilePath $ngrok -ArgumentList 'http','3001' -WindowStyle Minimized
}

$public = ''
for ($i = 0; $i -lt 20; $i++) {
  try {
    $tunnels = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3
    $public = @($tunnels.tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -ExpandProperty public_url) | Select-Object -First 1
    if ($public) { break }
  } catch {
    Start-Sleep -Seconds 1
  }
}

if ($public) {
  Set-Content -Path $urlFile -Value $public
} else {
  Set-Content -Path $urlFile -Value 'Cutline is starting. Open http://127.0.0.1:4040 if this file is still empty.'
}
