# T9 mutation probe: prove the new idempotency tests can FAIL.
#
# Each mutation disables one part of the fix, runs the suite with `node`, and
# records how many assertions went red. The source is restored after every
# mutation and the sha256 is compared at the end.
#
# Why this is pwsh and not node: under the confined DSH sandbox a node process
# cannot spawn a child (spawnSync fails with EPERM), so an earlier node-based
# runner silently measured NOTHING and reported zero failures for every
# mutation. pwsh may spawn, so the loop lives here and calls node directly.

$ErrorActionPreference = 'Continue'
Set-Location D:\DND\dsh-dnd-bundle

$target = 'src\host\tools\effects.mjs'
$resolved = (Resolve-Path $target).Path
$original = [System.IO.File]::ReadAllBytes($resolved)
$originalHash = (Get-FileHash $resolved -Algorithm SHA256).Hash
Write-Host "baseline sha256: $originalHash"

function Restore { [System.IO.File]::WriteAllBytes($resolved, $original) }

function RunSuite {
  $raw = & node test\encounter-effects.test.mjs 2>&1 | Out-String
  $fails = ([regex]::Matches($raw, 'FAIL ')).Count
  $passed = $raw -match 'all assertions passed'
  return @{ Fails = $fails; Passed = $passed }
}

$base = RunSuite
Write-Host ("baseline run: FAILs={0} allPassed={1}" -f $base.Fails, $base.Passed)
Write-Host ""

$crlf = [string][char]13 + [string][char]10
$mutations = @(
  @{ Name = 'A: death-save duplicate check removed';
     From = "        const duplicate = duplicateReply(loaded, key, action === 'reset' ? 'reset' : 'death save')" + $crlf + "        if (duplicate !== undefined) return duplicate";
     To   = '        // MUTATION A: the death-save check is gone' },
  @{ Name = 'B: requestKey always null (the ORIGINAL defect)';
     From = "  if (raw === undefined || raw === null || String(raw).trim() === '')" + " return null" + $crlf + "  return String(raw).trim()";
     To   = '  return null // MUTATION B: the key is never read' },
  @{ Name = 'C: ledger written but never checked';
     From = '    if (key === null || !loaded.appliedKeys.includes(key)) return undefined';
     To   = '    return undefined // MUTATION C: recorded but never checked' },
  @{ Name = 'D: concentration-start check removed';
     From = "          const startDuplicate = duplicateReply(loaded, key, 'start')" + $crlf + "          if (startDuplicate !== undefined) return startDuplicate";
     To   = '          // MUTATION D: the concentration-start check is gone' },
  @{ Name = 'E: key ledger cap removed';
     From = '  return next.slice(Math.max(0, next.length - MAX_ENCOUNTER_KEYS))';
     To   = '  return next // MUTATION E: the cap is gone' },
  @{ Name = 'F: party tick skips characters who already took the key';
     From = "        if (duplicateReply(loaded, key, 'tick') !== undefined) return null";
     To   = '        // MUTATION F: the per-character tick guard is gone' }
)

# Up-front anchor validation: a bad anchor must fail BEFORE any write, or the
# probe leaves the tree mutated (this happened once - see the T9 conclusion).
$text0 = [System.IO.File]::ReadAllText($resolved)
foreach ($m in $mutations) {
  if (-not $text0.Contains($m.From)) { Write-Host ("ANCHOR NOT FOUND: " + $m.Name); Restore; exit 2 }
}

$results = @()
foreach ($m in $mutations) {
  try {
    [System.IO.File]::WriteAllText($resolved, $text0.Replace($m.From, $m.To))
    $r = RunSuite
    $results += [pscustomobject]@{ Name = $m.Name; Fails = $r.Fails }
    Write-Host (($m.Name.PadRight(50, ".")) + " FAILs=" + $r.Fails + " allPassed=" + $r.Passed)
  } finally {
    Restore
  }
}

$restoredHash = (Get-FileHash $resolved -Algorithm SHA256).Hash
Write-Host ""
Write-Host "restored sha256: $restoredHash"
Write-Host ("RESTORED_BYTE_IDENTICAL=" + ($restoredHash -eq $originalHash))
Write-Host ""
$caught = ($results | Where-Object { $_.Fails -eq 0 }).Count -eq 0
Write-Host ("EVERY_MUTATION_WAS_CAUGHT=" + $caught)
$missed = $results | Where-Object { $_.Fails -eq 0 }
if ($missed) { Write-Host ("UNCAUGHT: " + (($missed | ForEach-Object { $_.Name }) -join "; ")) }
Write-Host ""
$final = RunSuite
Write-Host ("final run after restore: FAILs=" + $final.Fails + " allPassed=" + $final.Passed)