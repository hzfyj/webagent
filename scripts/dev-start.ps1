Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root ".runtime"
$memuraiDir = Join-Path $runtimeDir "memurai-portable-pkg\tools"
$memuraiExe = Join-Path $memuraiDir "memurai.exe"
$memuraiCli = Join-Path $memuraiDir "memurai-cli.exe"
$memuraiConf = Join-Path $runtimeDir "memurai.dev.conf"
$memuraiPidFile = Join-Path $runtimeDir "memurai.pid"
$gatewayPidFile = Join-Path $runtimeDir "gateway.pid"
$gatewayStdout = Join-Path $runtimeDir "gateway.stdout.log"
$gatewayStderr = Join-Path $runtimeDir "gateway.stderr.log"

function Test-ProcessAlive {
  param([string]$PidFile)

  if (-not (Test-Path $PidFile)) {
    return $null
  }

  $pidValue = (Get-Content $PidFile -Raw).Trim()
  if (-not $pidValue) {
    return $null
  }

  $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
  if (-not $process) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $null
  }

  return $process
}

function Find-MemuraiProcess {
  return Get-Process -Name "memurai" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $memuraiExe } |
    Select-Object -First 1
}

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

function Wait-Port {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 20
  )

  for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue
    if ($ok.TcpTestSucceeded) {
      return $true
    }
    Start-Sleep -Seconds 1
  }

  return $false
}

function Stop-IfUnhealthy {
  param(
    [System.Diagnostics.Process]$Process,
    [int]$Port,
    [string]$Name
  )

  if (-not $Process) {
    return $null
  }

  $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue
  if ($ok.TcpTestSucceeded) {
    return $Process
  }

  Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  Write-Output "${Name} process was stale, restarting"
  return $null
}

if (-not (Test-Path (Join-Path $root ".env"))) {
  throw "Missing .env. Expected file at $root\.env"
}

if (-not (Test-Path $memuraiExe)) {
  throw "Missing portable Memurai executable at $memuraiExe"
}

New-Item -ItemType Directory -Force -Path (Join-Path $runtimeDir "memurai-data") | Out-Null

$memuraiProcess = Test-ProcessAlive -PidFile $memuraiPidFile
if (-not $memuraiProcess) {
  $memuraiProcess = Find-MemuraiProcess
  if ($memuraiProcess) {
    Set-Content -Path $memuraiPidFile -Value $memuraiProcess.Id
  }
}
$memuraiProcess = Stop-IfUnhealthy -Process $memuraiProcess -Port 6379 -Name "Memurai"
if (-not $memuraiProcess) {
  $memuraiProcess = Start-Process -FilePath $memuraiExe `
    -ArgumentList $memuraiConf `
    -WorkingDirectory $memuraiDir `
    -PassThru
  Set-Content -Path $memuraiPidFile -Value $memuraiProcess.Id
  Write-Output "Started Memurai PID=$($memuraiProcess.Id)"
} else {
  Write-Output "Memurai already running PID=$($memuraiProcess.Id)"
}

if (-not (Wait-Port -Port 6379)) {
  throw "Memurai did not open port 6379 in time."
}

$ping = & $memuraiCli -p 6379 ping
if ($ping -ne "PONG") {
  throw "Memurai ping failed. Output: $ping"
}

Push-Location $root
try {
  npm run build | Out-Host
} finally {
  Pop-Location
}

$gatewayProcess = Test-ProcessAlive -PidFile $gatewayPidFile
if (-not $gatewayProcess) {
  $gatewayProcess = Find-GatewayProcess
  if ($gatewayProcess) {
    Set-Content -Path $gatewayPidFile -Value $gatewayProcess.Id
  }
}
$gatewayProcess = Stop-IfUnhealthy -Process $gatewayProcess -Port 8080 -Name "Gateway"
if (-not $gatewayProcess) {
  $gatewayProcess = Start-Process -FilePath "node" `
    -ArgumentList "dist/src/server.js" `
    -WorkingDirectory $root `
    -RedirectStandardOutput $gatewayStdout `
    -RedirectStandardError $gatewayStderr `
    -PassThru
  Set-Content -Path $gatewayPidFile -Value $gatewayProcess.Id
  Write-Output "Started gateway PID=$($gatewayProcess.Id)"
} else {
  Write-Output "Gateway already running PID=$($gatewayProcess.Id)"
}

if (-not (Wait-Port -Port 8080)) {
  throw "Gateway did not open port 8080 in time."
}

$livez = curl.exe --noproxy "*" -sS http://127.0.0.1:8080/livez
$readyz = curl.exe --noproxy "*" -sS http://127.0.0.1:8080/readyz

Write-Output "livez=$livez"
Write-Output "readyz=$readyz"
