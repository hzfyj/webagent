Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root ".runtime"
$memuraiExe = Join-Path $runtimeDir "memurai-portable-pkg\tools\memurai.exe"

function Find-GatewayProcess {
  $candidates = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
  $match = $candidates |
    Where-Object { $_.CommandLine -like "*dist/src/server.js*" -and $_.ExecutablePath -eq "C:\Program Files\nodejs\node.exe" } |
    Select-Object -First 1

  if (-not $match) {
    return $null
  }

  return Get-Process -Id $match.ProcessId -ErrorAction SilentlyContinue
}

function Find-MemuraiProcess {
  return Get-Process -Name "memurai" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $memuraiExe } |
    Select-Object -First 1
}

function Stop-ManagedProcess {
  param(
    [string]$Name,
    [string]$PidFile,
    [scriptblock]$Finder
  )

  $process = $null
  if (Test-Path $PidFile) {
    $pidValue = (Get-Content $PidFile -Raw).Trim()
    if ($pidValue) {
      $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    }
  }

  if (-not $process) {
    $process = & $Finder
  }

  if ($process) {
    Stop-Process -Id $process.Id -Force
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    Write-Output "${Name}: stopped PID=$($process.Id)"
  } else {
    Write-Output "${Name}: not running"
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-ManagedProcess -Name "gateway" -PidFile (Join-Path $runtimeDir "gateway.pid") -Finder ${function:Find-GatewayProcess}
Stop-ManagedProcess -Name "memurai" -PidFile (Join-Path $runtimeDir "memurai.pid") -Finder ${function:Find-MemuraiProcess}
