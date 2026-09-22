
# t10-mutation-probe.ps1 - prove calendar.test.mjs has the power to FAIL.
#
# WHY THIS IS POWERSHELL AND NOT NODE (the T9 trap, re-confirmed here):
# node CANNOT spawn a child process under this sandbox - execFileSync/spawnSync
# die with "EPERM spawnSync C:\Program Files\nodejs\node.exe EPERM". An earlier
# version of this probe was written in node, caught each failure as an empty
# stdout, and reported "caught, 0 red" for EVERY mutation - including ones that
# changed nothing. It looked like a passing test that tested nothing. Always
# assert the run actually executed: a mutation must produce a NON-ZERO exit and
# real FAIL lines, and the unmutated control must produce zero.
#
# Anchors are validated ALL-OR-NOTHING before any write, and restoration is in
# a finally block, so a missed anchor can never leave a mutation on disk (the
# other T9 trap).

# NOTE: NOT 'Stop'. node writes its FAIL lines to stderr, and with
# ErrorActionPreference='Stop' PowerShell turns that into a terminating
# NativeCommandError - the probe would abort on the first mutation that was
# correctly caught. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'
$FILE = 'src/host/tools/calendar.mjs'
$TEST = 'test/calendar.test.mjs'
$original = [System.IO.File]::ReadAllBytes($FILE)
$originalText = [System.IO.File]::ReadAllText($FILE)
$originalSha = (Get-FileHash -Algorithm SHA256 $FILE).Hash

function Count-Red([string]$out) { ([regex]::Matches($out, 'FAIL ')).Count }

# Run the suite and return its output as a string.
#
# The output is redirected to a FILE and read back rather than piped through
# "2>&1 | Out-String". Piping merges node's stderr into PowerShell's error
# stream, and PowerShell then INJECTS its own multi-line NativeCommandError
# records into the captured text - which made "FAIL" lines look absent and made
# correctly-caught mutations report red=0. A file has no such rewriting.
$script:outFile = Join-Path $env:TEMP ('t10-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
function Run-Suite {
  & node $TEST *> $script:outFile
  $script:lastExit = $LASTEXITCODE
  return [System.IO.File]::ReadAllText($script:outFile)
}

$mutations = @(
  @{ id='A'; why='year carry removed (never wraps into a new year)'
     from='  const yearIndex = Math.floor(allDays / (perMonth * perYear))'
     to='  allDays = allDays % (perMonth * perYear); const yearIndex = Math.floor(allDays / (perMonth * perYear))' },
  @{ id='B'; why='long rest is no longer 8 hours'
     from='export const REST_HOURS = { short: 1, long: 8 }'
     to='export const REST_HOURS = { short: 1, long: 1 }' },
  @{ id='C'; why='policy no longer threaded to writeText (T2 defect returns)'
     from='undefined, undefined, policy)'
     to='undefined)   /* mutation C: policy dropped */' },
  @{ id='D'; why='idempotency key never persisted (a retry advances twice)'
     from='        next.appliedKeys = keys.slice(Math.max(0, keys.length - MAX_CALENDAR_KEYS))'
     to='        next.appliedKeys = applied' },
  @{ id='E'; why='negative advance allowed (time runs backwards)'
     from='        if (Math.trunc(amount) < 0) {'
     to='        if (false) {' },
  @{ id='F'; why='month-end carry broken (month_length ignored)'
     from='  const perMonth = daysInMonth(src)'
     to='  const perMonth = 31' }
)

# ---- validate every anchor BEFORE writing anything ----
$bad = @()
foreach ($m in $mutations) {
  $n = ([regex]::Matches($originalText, [regex]::Escape($m.from))).Count
  if ($n -ne 1) { $bad += ($m.id + ': anchor occurs ' + $n + ' times') }
}
if ($bad.Count -gt 0) {
  Write-Host 'ANCHOR VALIDATION FAILED (nothing written):'
  $bad | ForEach-Object { Write-Host ('  ' + $_) }
  exit 2
}
Write-Host ('anchors validated: ' + $mutations.Count + '/' + $mutations.Count)

# ---- control run: the SUITE MUST PASS unmutated ----
$controlOut = Run-Suite
$controlRed = Count-Red $controlOut
$controlPass = $controlOut -match 'all assertions passed'
Write-Host ('CONTROL (unmutated): passed=' + $controlPass + ' red=' + $controlRed)
if (-not $controlPass -or $controlRed -ne 0) {
  Write-Host 'CONTROL FAILED - the suite does not pass clean; mutation results would be meaningless.'
  exit 2
}

# ---- run each mutation, always restoring ----
$allCaught = $true
try {
  foreach ($m in $mutations) {
    $mutated = $originalText.Replace($m.from, $m.to)
    [System.IO.File]::WriteAllText($FILE, $mutated)
    $out = Run-Suite
    $exit = $script:lastExit
    $red = Count-Red $out
    $pass = $out -match 'all assertions passed'
    $caught = (-not $pass) -and ($exit -ne 0) -and ($red -gt 0)
    if (-not $caught) { $allCaught = $false }
    $verdict = if ($caught) { 'caught' } else { 'SURVIVED *** BLIND SPOT ***' }
    Write-Host ('mutation ' + $m.id + ': ' + $verdict + '  exit=' + $exit + ' red=' + $red + '  [' + $m.why + ']')
    if ($red -gt 0 -and $red -le 4) {
      ([regex]::Matches($out, '(?m)^\s*FAIL .*$')) | ForEach-Object { Write-Host ('      ' + $_.Value.Trim()) }
    }
  }
} finally {
  [System.IO.File]::WriteAllBytes($FILE, $original)
  if (Test-Path $script:outFile) { Remove-Item $script:outFile -Force }
}

$restoredSha = (Get-FileHash -Algorithm SHA256 $FILE).Hash
Write-Host ''
Write-Host ('RESTORED_BYTE_IDENTICAL=' + ($restoredSha -eq $originalSha))
Write-Host ('EVERY_MUTATION_WAS_CAUGHT=' + $allCaught)
if (-not $allCaught) { exit 1 }
