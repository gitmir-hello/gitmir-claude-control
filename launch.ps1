# Starts GitMir Local without a console window and opens it in the browser.
# You are not meant to run this by hand — install-shortcut.cmd makes a Desktop shortcut
# that calls it. Running it directly works too.
$ErrorActionPreference = 'SilentlyContinue'

$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:GITMIR_PORT) { $env:GITMIR_PORT } else { '4599' }
$url  = "http://localhost:$port"

function Test-Up {
    try { $null = Invoke-WebRequest "$url/api/ping" -TimeoutSec 2 -UseBasicParsing; return $true }
    catch { return $false }
}

# Already running? Just show it — never start a second one.
if (Test-Up) { Start-Process $url; exit 0 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "Node.js was not found. Install Node.js 18 or newer (22+ for the Team bridge) from nodejs.org, then try again.",
        "GitMir Local") | Out-Null
    exit 1
}

# Hidden and detached: the dashboard outlives this launcher and anything you close.
Start-Process -FilePath $node -ArgumentList 'server.ts' -WorkingDirectory $dir -WindowStyle Hidden

for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Up) { Start-Process $url; exit 0 }
}

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
    "The dashboard did not start within 15 seconds. Try running 'node server.ts' in`n$dir`nto see the error.",
    "GitMir Local") | Out-Null
exit 1
