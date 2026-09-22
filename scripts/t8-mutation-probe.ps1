$P = 'D:\DND\dsh-dnd-bundle\src\host\tools\initiative.mjs'
$before = (Get-FileHash -Algorithm SHA256 $P).Hash
Write-Output "BEFORE_SHA=$before"
function RunSuite($label) {
  $out = (& node 'D:\DND\dsh-dnd-bundle\test\initiative.test.mjs' 2>&1 | Out-String)
  $fails = @($out -split "`n" | Where-Object { $_ -match '^  FAIL|failure\(s\)|all assertions passed' })
  Write-Output ("--- MUTATION " + $label + " ---")
  $fails | ForEach-Object { Write-Output ('    ' + $_.Trim()) }
}
$orig = [System.IO.File]::ReadAllText($P)
function TryMutate($label, $from, $to) {
  $mut = $orig.Replace($from, $to)
  if ($mut -eq $orig) { Write-Output ("--- MUTATION " + $label + " --- PATCH DID NOT APPLY"); return }
  [System.IO.File]::WriteAllText($P, $mut)
  RunSuite $label
  [System.IO.File]::WriteAllText($P, $orig)
}
$nl = [char]10
$B1 = '      pending.push({ ...entry, mod, pending: true })'
$B2 = '      void rollD20(mod, false, false)' + $nl + '      pending.push({ ...entry, mod, pending: true })'
TryMutate 'B PC-rolled-then-discarded (weak reading)' $B1 $B2
$A1 = 'if (b.entry.initiative !== a.entry.initiative) return b.entry.initiative - a.entry.initiative'
$A2 = 'if (b.entry.initiative !== a.entry.initiative) return a.entry.initiative - b.entry.initiative'
TryMutate 'A sort-ASCENDING (the shipped bug)' $A1 $A2
$C1 = '          mergeEncounter(existing.encounter, INITIATIVE_SECTION, section),'
$C2 = '          mergeEncounter(existing.encounter, INITIATIVE_SECTION, section), void 0,'
TryMutate 'C persistence-bypassed' $C1 $C2
$D1 = '    if (given !== undefined) {'
$D2 = '    if (false) {'
TryMutate 'D supplied-roll-ignored' $D1 $D2
$E1 = '  return DM_ROLL_MODES.has(value) ? ' + [char]39 + 'dm' + [char]39 + ' : ' + [char]39 + 'players' + [char]39
$E2 = '  return ' + [char]39 + 'dm' + [char]39
TryMutate 'E roll_mode-always-dm' $E1 $E2
[System.IO.File]::WriteAllText($P, $orig)
$after = (Get-FileHash -Algorithm SHA256 $P).Hash
Write-Output "AFTER_SHA=$after"
Write-Output ('RESTORED_BYTE_IDENTICAL=' + ($before -eq $after))
$clean = (& node 'D:\DND\dsh-dnd-bundle\test\initiative.test.mjs' 2>&1 | Select-Object -Last 1 | Out-String)
Write-Output ('POST-RESTORE-SUITE: ' + $clean.Trim())