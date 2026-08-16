# GitMir Local — install in one line, on Windows.
#
#   irm https://ide.gitmir.com/install.ps1 | iex
#
# Clones into %USERPROFILE%\.gitmir\local and puts a `gitmir` command
# on your PATH. Nothing is compiled and nothing comes from a package registry:
# Node runs the TypeScript directly, and the fonts and renderer are in the repo.
#
# Run it again to update.

$ErrorActionPreference = 'Stop'

$Repo   = if ($env:GITMIR_REPO)   { $env:GITMIR_REPO }   else { 'https://github.com/gitmir-hello/gitmir-local.git' }
$Branch = if ($env:GITMIR_BRANCH) { $env:GITMIR_BRANCH } else { 'main' }
$Dir    = if ($env:GITMIR_HOME)   { $env:GITMIR_HOME }   else { Join-Path $env:USERPROFILE '.gitmir\local' }
$BinDir = if ($env:GITMIR_BIN)    { $env:GITMIR_BIN }    else { Join-Path $env:USERPROFILE '.gitmir\bin' }

function Step($m) { Write-Host "  · $m" -ForegroundColor Cyan }
function Die($m)  { Write-Host ""; Write-Host "  x $m" -ForegroundColor Red; Write-Host ""; exit 1 }

Write-Host ""
Write-Host "  GitMir Local" -ForegroundColor Cyan
Write-Host ""

# --- node ---------------------------------------------------------------------
# Below 22.18 Node cannot strip TypeScript types, and the server fails on a type
# annotation instead of saying what is wrong. Check before anything else.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "Node.js is not installed.`n    Get it from https://nodejs.org — version 22.18 or newer.`n    (winget install OpenJS.NodeJS.LTS)"
}
$v = (& node -v).TrimStart('v')
$parts = $v.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 18)) {
  Die "Node $v is too old.`n    This runs TypeScript with no build step, which Node can do from 22.18.`n    Node 18 and 20 are both past end of life."
}
Step "Node $v"

# --- fetch --------------------------------------------------------------------
# The project was called gitmir-claude-control and installed into .gitmir\claude-control.
# Move an existing checkout rather than cloning a second copy beside it: git
# redirects the old remote, so the moved one keeps updating without being touched.
$old = Join-Path $env:USERPROFILE '.gitmir\claude-control'
if ((Test-Path (Join-Path $old '.git')) -and -not (Test-Path (Join-Path $Dir '.git'))) {
  Step "Moving the earlier install: $old -> $Dir"
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
  Move-Item -Path $old -Destination $Dir
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $Dir '.git')) {
  Step "Updating $Dir"
  git -C $Dir fetch --quiet origin $Branch
  git -C $Dir checkout --quiet $Branch
  # Hard reset rather than merge: a half-merged checkout is a worse outcome for
  # an install script than losing a local edit nobody meant to make here.
  git -C $Dir reset --quiet --hard "origin/$Branch"
}
elseif ($git) {
  Step "Cloning into $Dir"
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
  git clone --quiet --depth 1 --branch $Branch $Repo $Dir
}
else {
  Step "No git — downloading a snapshot into $Dir"
  $tar = ($Repo -replace '\.git$','') + "/archive/refs/heads/$Branch.zip"
  $tmp = Join-Path $env:TEMP "gitmir-$([guid]::NewGuid()).zip"
  Invoke-WebRequest -Uri $tar -OutFile $tmp
  $stage = Join-Path $env:TEMP "gitmir-$([guid]::NewGuid())"
  Expand-Archive -Path $tmp -DestinationPath $stage -Force
  $inner = Get-ChildItem $stage | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Dir -Recurse -Force
  Remove-Item $tmp, $stage -Recurse -Force
}

# --- the command ---------------------------------------------------------------
# A shim, not a copy of the launcher: it calls into the checkout, so an update
# to the repository updates what the command does.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$shim = Join-Path $BinDir 'gitmir.cmd'
@"
@echo off
node "$Dir\bin\gitmir.mjs" %*
"@ | Set-Content -Path $shim -Encoding ASCII
Step "Wrote $shim"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
  Step "Added $BinDir to your PATH — open a new terminal for it to take effect"
}

Write-Host ""
Write-Host "  Installed." -ForegroundColor Green
Write-Host ""
Write-Host "      gitmir              start it and open the browser"
Write-Host "      gitmir mcp add      let your agent use the same model"
Write-Host "      gitmir status       node, port, version, what is missing"
Write-Host "      gitmir update       pull the latest"
Write-Host ""
Write-Host "  The dashboard needs the 'claude' CLI on your PATH to run Claude for you."
Write-Host "  Nothing is uploaded anywhere and there is no telemetry — see SECURITY.md."
Write-Host ""
