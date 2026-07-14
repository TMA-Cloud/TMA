<#
  End-to-end test for the TMA Cloud WinFsp provider against the mock bridge.
  Starts the mock bridge, mounts the filesystem to a drive letter, exercises
  read/write/mkdir/rename/delete, prints PASS/FAIL, then tears everything down.

  Run:  powershell -ExecutionPolicy Bypass -File test\run-mount-test.ps1
#>
param(
  [string]$Drive = 'X:',
  [string]$Exe   = "$PSScriptRoot\..\bin\Release\TmaCloudFs.exe",
  [string]$Mock  = "$PSScriptRoot\mock-bridge.cjs"
)

$ErrorActionPreference = 'Stop'
$pipe = "tma-cloud-fs-test-$PID"
$logDir = Join-Path $env:TEMP "tma-fs-test"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$mockOut = Join-Path $logDir 'mock.log'
$fsOut   = Join-Path $logDir 'fs.out.log'
$fsErr   = Join-Path $logDir 'fs.err.log'

$results = [System.Collections.Generic.List[string]]::new()
$fail = 0
function Check($name, $cond) {
  if ($cond) { $script:results.Add("PASS  $name") }
  else       { $script:results.Add("FAIL  $name"); $script:fail++ }
}
# Evaluate a scriptblock, returning $true only if it runs without error and
# yields a truthy value — so one failing step never aborts the whole suite.
function Test-Step([scriptblock]$b) {
  try { [bool](& $b) } catch { $false }
}

$mockProc = $null
$fsProc = $null
try {
  Write-Host "Starting mock bridge (pipe=$pipe)..."
  $mockProc = Start-Process -FilePath 'node' -ArgumentList @($Mock, $pipe) `
    -RedirectStandardError $mockOut -RedirectStandardOutput (Join-Path $logDir 'mock.stdout.log') `
    -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 700   # let the pipe server bind

  Write-Host "Mounting filesystem to $Drive ..."
  $fsProc = Start-Process -FilePath $Exe `
    -ArgumentList @('--pipe', $pipe, '--mount', $Drive, '--label', 'TMA Cloud') `
    -RedirectStandardOutput $fsOut -RedirectStandardError $fsErr `
    -PassThru -WindowStyle Hidden

  # Wait for the drive to appear
  $mounted = $false
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path "$Drive\") { $mounted = $true; break }
    if ($fsProc.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  Check "drive $Drive mounted" $mounted
  if ($mounted) { Start-Sleep -Milliseconds 1200 }  # let the volume settle
  if (-not $mounted) {
    Write-Host "--- fs.err ---"; Get-Content $fsErr -ErrorAction SilentlyContinue
    Write-Host "--- fs.out ---"; Get-Content $fsOut -ErrorAction SilentlyContinue
    throw "mount failed"
  }

  # 1. List root — expect seeded entries
  $names = Test-Step { (Get-ChildItem "$Drive\" | Select-Object -ExpandProperty Name) }
  $names = @(Get-ChildItem "$Drive\" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  Check "root lists hello.txt"  ($names -contains 'hello.txt')
  Check "root lists Documents"  ($names -contains 'Documents')

  # 2. Read a seeded file
  Check "read hello.txt content" (Test-Step { (Get-Content "$Drive\hello.txt" -Raw) -like 'Hello from TMA Cloud!*' })

  # 3. Descend into a subfolder
  $sub = @(Get-ChildItem "$Drive\Documents" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  Check "Documents lists readme.md" ($sub -contains 'readme.md')

  # 4. Write a NEW file (the Save-As path)
  $payload = "written-by-test-$(Get-Random)"
  Check "new file round-trips content" (Test-Step {
    Set-Content -Path "$Drive\note.txt" -Value $payload -NoNewline -Encoding ASCII
    Start-Sleep -Milliseconds 500   # allow write-back upload on close
    (Get-Content "$Drive\note.txt" -Raw) -eq $payload
  })

  # 5. Overwrite an existing file with a truncating writer (CREATE_ALWAYS) —
  #    the path real apps and Save As dialogs use. (PowerShell's Set-Content
  #    opens append-style over WinFsp, which is not representative.)
  $payload2 = "overwritten-$(Get-Random)"
  Check "overwrite round-trips content" (Test-Step {
    [System.IO.File]::WriteAllText("$Drive\note.txt", $payload2)
    Start-Sleep -Milliseconds 500
    ([System.IO.File]::ReadAllText("$Drive\note.txt")) -eq $payload2
  })

  # 6. mkdir
  Check "mkdir NewFolder" (Test-Step {
    New-Item -ItemType Directory -Path "$Drive\NewFolder" | Out-Null
    Test-Path "$Drive\NewFolder"
  })

  # 7. rename
  Check "rename note.txt -> renamed.txt" (Test-Step {
    Rename-Item "$Drive\note.txt" "renamed.txt"
    Start-Sleep -Milliseconds 400
    (Test-Path "$Drive\renamed.txt") -and -not (Test-Path "$Drive\note.txt")
  })

  # 8. move (rename across directories)
  Check "move into Documents" (Test-Step {
    Move-Item "$Drive\renamed.txt" "$Drive\Documents\moved.txt"
    Start-Sleep -Milliseconds 400
    (Test-Path "$Drive\Documents\moved.txt") -and -not (Test-Path "$Drive\renamed.txt")
  })

  # 9. delete
  Check "delete moved.txt" (Test-Step {
    Remove-Item "$Drive\Documents\moved.txt"
    Start-Sleep -Milliseconds 400
    -not (Test-Path "$Drive\Documents\moved.txt")
  })
}
finally {
  Write-Host ""
  if ($fsProc -and -not $fsProc.HasExited) {
    try { $fsProc.Kill() } catch {}
  }
  Start-Sleep -Milliseconds 500
  if ($mockProc -and -not $mockProc.HasExited) {
    try { $mockProc.Kill() } catch {}
  }
}

Write-Host ""
Write-Host "==================== RESULTS ===================="
$results | ForEach-Object { Write-Host $_ }
Write-Host "================================================="
if ($fail -gt 0) {
  Write-Host "$fail check(s) failed."
  Write-Host "--- mock.log (tail) ---"
  Get-Content $mockOut -Tail 30 -ErrorAction SilentlyContinue
  Write-Host "--- fs.err (tail) ---"
  Get-Content $fsErr -Tail 30 -ErrorAction SilentlyContinue
  exit 1
} else {
  Write-Host "All checks passed."
  exit 0
}
