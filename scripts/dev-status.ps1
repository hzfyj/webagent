Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root ".runtime"
$memuraiCli = Join-Path $runtimeDir "memurai-portable-pkg\tools\memurai-cli.exe"
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

function Show-ProcessStatus {
  param(
    [string]$Name,
    [string]$PidFile,
    [scriptblock]$Finder
  )

  $process = $null
  if (-not (Test-Path $PidFile)) {
    $process = & $Finder
    if (-not $process) {
      Write-Output "${Name}: not running"
      return
    }
  }

  if (-not $process) {
    $pidValue = (Get-Content $PidFile -Raw).Trim()
    if ($pidValue) {
      $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    }
  }

  if (-not $process) {
    $process = & $Finder
  }

  if ($process) {
    Write-Output "${Name}: running PID=$($process.Id)"
  } else {
    Write-Output "${Name}: stale pid file"
  }
}

Show-ProcessStatus -Name "gateway" -PidFile (Join-Path $runtimeDir "gateway.pid") -Finder ${function:Find-GatewayProcess}
Show-ProcessStatus -Name "memurai" -PidFile (Join-Path $runtimeDir "memurai.pid") -Finder ${function:Find-MemuraiProcess}

$redis = Test-NetConnection -ComputerName 127.0.0.1 -Port 6379 -WarningAction SilentlyContinue
$gateway = Test-NetConnection -ComputerName 127.0.0.1 -Port 8080 -WarningAction SilentlyContinue

Write-Output "redis-port-6379=$($redis.TcpTestSucceeded)"
Write-Output "gateway-port-8080=$($gateway.TcpTestSucceeded)"

if ((Test-Path $memuraiCli) -and $redis.TcpTestSucceeded) {
  $ping = & $memuraiCli -p 6379 ping 2>$null
  Write-Output "redis-ping=$ping"
}

if ($gateway.TcpTestSucceeded) {
  $livez = curl.exe --noproxy "*" -sS http://127.0.0.1:8080/livez
  $readyz = curl.exe --noproxy "*" -sS http://127.0.0.1:8080/readyz
  Write-Output "livez=$livez"
  Write-Output "readyz=$readyz"
}
