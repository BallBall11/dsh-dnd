
# t6-t7-mutation-probe.ps1 - prove write-errors.test.mjs has the power to FAIL.
#
# Same two traps T9/T10 recorded, both already handled here:
#   - node CANNOT spawn under this sandbox (EPERM), so this MUST be PowerShell
#     driving node directly. A node-based probe reports "caught, 0 red" for
#     every mutation because the child never ran.
#   - node writes FAIL lines to stderr; piping them merges PowerShell's own
#     NativeCommandError records into the captured text. Redirect to a FILE.
#
# Anchors are validated ALL-OR-NOTHING before any write, and restoration is in
# a finally block, so a missed anchor cannot leave a mutation on disk.

$ErrorActionPreference = 'Continue'
$FILES = @('src/host/tools/write-errors.mjs', 'src/host/tools/write-probe.mjs')
$TEST = 'test/write-errors.test.mjs'
$originals = @{}
$originalsText = @{}
$originalShas = @{}
foreach ($f in $FILES) {
  $originals[$f] = [System.IO.File]::ReadAllBytes($f)
  $originalsText[$f] = [System.IO.File]::ReadAllText($f)
  $originalShas[$f] = (Get-FileHash -Algorithm SHA256 $f).Hash
}

function Count-Red([string]$out) { ([regex]::Matches($out, 'FAIL ')).Count }

$outFile = Join-Path $env:TEMP ('t67-' + [guid]::NewGuid().ToString('N') + '.txt')
function Run-Suite {
  & node $TEST *> $outFile
  $script:lastExit = $LASTEXITCODE
  return [System.IO.File]::ReadAllText($outFile)
}

$mutations = @(
  @{ id='A'; file='src/host/tools/write-errors.mjs'
     why='refusal no longer recognised (the whole diagnosis goes dark)'
     from="  if (error.code === SANDBOX_DENIED) return true"
     to="  if (false) return true" },
  @{ id='B'; file='src/host/tools/write-errors.mjs'
     why='path extraction removed (message cannot name what was refused)'
     from='  const match = /cannot (?:write|read|create|delete) "([^"]+)"/i.exec(message)'
     to='  const match = null' },
  @{ id='C'; file='src/host/tools/write-errors.mjs'
     why='no-session branch deleted (the process-cwd diagnosis disappears)'
     from='    lines.push(''  DIAGNOSIS: this write carried NO session policy. The path was judged'')'
     to='    /* mutation C: diagnosis removed */' },
  @{ id='D'; file='src/host/tools/write-errors.mjs'
     why='remedies removed (message restates the mode and stops - the original complaint)'
     from="    lines.push('    - start the session with its cwd at (or above) the campaign root;')"
     to="    lines.push('    (mutation D: the session branch offers no remedy)')" },
  @{ id='E'; file='src/host/tools/write-errors.mjs'
     why='unrelated errors swallowed into the sandbox message (masks real failures)'
     from='    if (!isSandboxDenial(error)) throw error'
     to='    if (false) throw error' },
  @{ id='F'; file='src/host/tools/write-probe.mjs'
     why='non-sandbox failure blamed on the sandbox (wrong diagnosis)'
     from="    return { status: PROBE_SKIPPED, path, error, message: 'probe could not run: ' + (error?.message ?? error) }"
     to="    return { status: PROBE_REFUSED, path, error, message: 'blamed on sandbox' }" },
  @{ id='G'; file='src/host/tools/write-probe.mjs'
     why='probe state never published (write tools show no advisory)'
     from="    const result = await probeWrite(fs, campaignDir, { sandboxPolicy: options.policy })
    state.set(result)"
     to="    const result = await probeWrite(fs, campaignDir, { sandboxPolicy: options.policy })
    /* mutation G: not published */" },
  @{ id='H'; file='src/host/tools/write-probe.mjs'
     why='self-check runs on EVERY call instead of once (noise + repeated writes)'
     from='  if (state.last !== undefined) return state.last'
     to='  if (false) return state.last' },
  @{ id='I'; file='src/host/tools/write-probe.mjs'
     why='explicit empty campaignDir falls through to a live lookup (the LEAK)'
     from="    const supplied = Object.prototype.hasOwnProperty.call(options, 'campaignDir')"
     to='    const supplied = false' }
)

# ---- validate every anchor BEFORE writing anything ----
$bad = @()
foreach ($m in $mutations) {
  $n = ([regex]::Matches($originalsText[$m.file], [regex]::Escape($m.from))).Count
  if ($n -ne 1) { $bad += ($m.id + ' [' + $m.file + ']: anchor occurs ' + $n + ' times') }
}
if ($bad.Count -gt 0) {
  Write-Host 'ANCHOR VALIDATION FAILED (nothing written):'
  $bad | ForEach-Object { Write-Host ('  ' + $_) }
  exit 2
}
Write-Host ('anchors validated: ' + $mutations.Count + '/' + $mutations.Count)

# ---- control: the suite MUST pass unmutated ----
$controlOut = Run-Suite
Write-Host ('CONTROL (unmutated): passed=' + ($controlOut -match 'all assertions passed') + ' red=' + (Count-Red $controlOut))
if (-not ($controlOut -match 'all assertions passed') -or (Count-Red $controlOut) -ne 0) {
  Write-Host 'CONTROL FAILED - mutation results would be meaningless.'; exit 2
}

# ---- run each mutation, always restoring ----
$allCaught = $true
try {
  foreach ($m in $mutations) {
    [System.IO.File]::WriteAllText($m.file, $originalsText[$m.file].Replace($m.from, $m.to))
    $out = Run-Suite
    $exit = $script:lastExit
    $red = Count-Red $out
    $pass = $out -match 'all assertions passed'
    $caught = (-not $pass) -and ($exit -ne 0) -and ($red -gt 0)
    if (-not $caught) { $allCaught = $false }
    Write-Host ('mutation ' + $m.id + ': ' + $(if ($caught) { 'caught' } else { 'SURVIVED *** BLIND SPOT ***' }) + "  exit=$exit red=$red  [" + $m.why + ']')
    # restore this file immediately so the next mutation starts clean
    [System.IO.File]::WriteAllBytes($m.file, $originals[$m.file])
  }
} finally {
  foreach ($f in $FILES) { [System.IO.File]::WriteAllBytes($f, $originals[$f]) }
  if (Test-Path $outFile) { Remove-Item $outFile -Force }
}

$restored = $true
foreach ($f in $FILES) { if ((Get-FileHash -Algorithm SHA256 $f).Hash -ne $originalShas[$f]) { $restored = $false } }
Write-Host ''
Write-Host ('RESTORED_BYTE_IDENTICAL=' + $restored)
Write-Host ('EVERY_MUTATION_WAS_CAUGHT=' + $allCaught)
if (-not $allCaught -or -not $restored) { exit 1 }
