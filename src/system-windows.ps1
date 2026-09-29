$ErrorActionPreference = 'Stop'
$result = @{ gpuPresent = $null; gpu = $null; disks = @() }
try {
  $result.gpuPresent = @(Get-CimInstance Win32_VideoController).Count -gt 0
} catch {}
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
