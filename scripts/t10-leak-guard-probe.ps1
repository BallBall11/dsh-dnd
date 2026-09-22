
$ErrorActionPreference = 'Continue'
$TEST = 'test/write-errors.test.mjs'
$original = [System.IO.File]::ReadAllText($TEST)
$outFile = Join-Path $env:TEMP ('t10-leak-' + [guid]::NewGuid().ToString('N') + '.txt')

# Anchor: make deniedFs.resolve bypass the guard (simulating the old leak).
$from = '  async resolve(p) { return { displayPath: guard(p, ''resolve'') } },
  async writeText(t) { throw denied(guard(String(t.displayPath), ''writeText'')) },'
$to = '  async resolve(p) { return { displayPath: String(p) } },
  async writeText(t) { throw denied(String(t.displayPath)) },'

if (([regex]::Matches($original, [regex]::Escape($from))).Count -ne 1) {
  Write-Host 'ANCHOR FAILED - nothing written'; exit 2
}

$liveBefore = if (Test-Path 'D:\DND\campaigns\retest-alice\.dnd-write-probe.tmp') { 'present' } else { 'absent' }
try {
  [System.IO.File]::WriteAllText($TEST, $original.Replace($from, $to))
  & node $TEST *> $outFile
  Write-Host ('mutated run exit=' + $LASTEXITCODE)
  Write-Host ('control would be 0; nonzero means the guard/anchor changed behaviour')
} finally {
  [System.IO.File]::WriteAllText($TEST, $original)
  if (Test-Path $outFile) { Remove-Item $outFile -Force }
}
$liveAfter = if (Test-Path 'D:\DND\campaigns\retest-alice\.dnd-write-probe.tmp') { 'present' } else { 'absent' }
Write-Host ('live probe file before=' + $liveBefore + ' after=' + $liveAfter)
Write-Host ('RESTORED=' + ([System.IO.File]::ReadAllText($TEST) -eq $original))
