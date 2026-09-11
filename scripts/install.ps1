# dsh-dnd install helper (Windows PowerShell 5.1+ / pwsh)
#
# Installs the dsh-dnd bundle for a profile through the official DSH CLI:
#   dsh plugin --profile web add dsh-dnd@<version>
# The bundle declares `dsh.bundle.patch` (cordis.patch.yml) + `dsh.client`, so
# the CLI reconciles `dsh.profile.bundles`, appends it to the stack, and mounts
# the Host tools + Client panel on next boot — no manual profile edits.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1            # no args → local bundle
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Version 1.0.0   # from registry
#
# Params:
#   -Version   npm version/range (default: local link install from this repo)
#   -Profile   target profile name (default web)
#   -Restart   attempt to restart the web profile (pm2 if present)
#   -DryRun    print actions only
#
# Env:
#   DSH_HOME   default %USERPROFILE%\.dsh
#   REGISTRY   default https://registry.npmjs.org
#   DSH_CMD    default `dsh` from PATH, else npx @deepseek-ai/dsh
param(
  [string]$Version = '',
  [string]$Profile = 'web',
  [switch]$Restart,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$PKG = 'dsh-dnd'
$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$DSH_CMD = $env:DSH_CMD; if (-not $DSH_CMD) { $DSH_CMD = if (Get-Command dsh -ErrorAction SilentlyContinue) { 'dsh' } else { 'npx -y --package @deepseek-ai/dsh dsh' } }
$repoRoot = Split-Path -Parent $PSScriptRoot

function Step($m) { Write-Host ":: $m" -ForegroundColor Cyan }
function Run($cmd) { Write-Host "> $cmd" -ForegroundColor DarkGray; if (-not $DryRun) { Invoke-Expression $cmd } }

Step "Profile: $Profile  DSH_HOME: $DSH_HOME"
if ($Version) {
  Step "Installing $PKG@$Version from registry"
  Run "$DSH_CMD plugin --profile $Profile add $PKG@$Version"
  $installedSpec = "$PKG@$Version"
} else {
  Step 'Installing the local bundle (link) — no registry needed, git-tracked version'
  Run "$DSH_CMD plugin --profile $Profile add link:$repoRoot"
  $installedSpec = "$PKG (link:$repoRoot)"
}

Step "Done installing: $installedSpec"
Step 'If an older dnd-host manual mount row exists in the profile! cordis.patch.yml, remove it to avoid double-mounting.'
if ($Restart -and -not $DryRun) {
  Step 'Restarting web profile'
  if (Get-Command pm2 -ErrorAction SilentlyContinue) { Run 'pm2 restart dsh-web' } else { Write-Host 'pm2 not found — restart the web profile manually.' }
}
