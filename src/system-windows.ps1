# Long-lived hardware sampler. Usage Monitor keeps one copy running and writes "sample" on
# stdin every 5 seconds ("sample storage" every 30 seconds also lists the local drives);
# each request gets one JSON line back. Starting PowerShell for every
# sample cost about half of the CPU the sampling used. The loop ends when stdin closes, so
# the process never outlives the app.
$ErrorActionPreference = 'Stop'
$script:gpuPresent = $null
$script:gpuCheckedAt = [DateTime]::MinValue

function Get-Sample($withStorage) {
  $result = @{ gpuPresent = $null; gpu = $null; disks = @() }
  if ($withStorage) {
    # Local fixed drives, here instead of a new PowerShell process for every storage reading.
    try {
      $result.volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
        Where-Object { $_.Size -gt 0 } |
        ForEach-Object { @{ mount = $_.DeviceID; size = [double]$_.Size; used = [double]($_.Size - $_.FreeSpace) } })
    } catch {}
  }
  # Graphics adapters rarely change, so the adapter list is refreshed every 5 minutes.
  if (([DateTime]::UtcNow - $script:gpuCheckedAt).TotalMinutes -ge 5) {
    try { $script:gpuPresent = @(Get-CimInstance Win32_VideoController).Count -gt 0 } catch {}
    $script:gpuCheckedAt = [DateTime]::UtcNow
  }
  $result.gpuPresent = $script:gpuPresent
  try {
    # Sum processes sharing an engine, then select the busiest engine (Task Manager semantics).
    $engines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
    $groups = $engines | Group-Object { $_.Name -replace '^pid_\d+_', '' }
    $values = @($groups | ForEach-Object { ($_.Group | Measure-Object UtilizationPercentage -Sum).Sum })
    if ($values.Count -gt 0) {
      $result.gpu = [Math]::Min(100, ($values | Measure-Object -Maximum).Maximum)
      $result.gpuPresent = $true
    }
  } catch {}
  try {
    $result.disks = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk |
      Where-Object { $_.Name -ne '_Total' } |
      ForEach-Object { @{ name = $_.Name; busy = [Math]::Max(0, [Math]::Min(100, 100 - [double]$_.PercentIdleTime)) } })
  } catch {}
  $result | ConvertTo-Json -Depth 4 -Compress
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq 'exit') { break }
  if ($line -ne 'sample' -and $line -ne 'sample storage') { continue }
  try { $json = Get-Sample ($line -eq 'sample storage') } catch { $json = '{"error":true}' }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
