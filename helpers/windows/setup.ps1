# Installs, repairs, or removes the Usage Monitor network capture helper.
# Usage Monitor runs this elevated (one UAC prompt). The helper is compiled from
# NetCapture.cs into Program Files, which only administrators can change, and is
# started by a SYSTEM scheduled task that the signed-in user may run.
param(
  [string]$Source,
  [Parameter(Mandatory = $true)][string]$UserSid,
  [Parameter(Mandatory = $true)][string]$Result,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

function Write-Result([bool]$Ok, [string]$Message, [string]$Version, [string]$Warning) {
  $json = @{ ok = $Ok; error = $Message; version = $Version; warning = $Warning } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($Result, $json, (New-Object Text.UTF8Encoding($false)))
}

try {
  if ($UserSid -notmatch '^S-1-(5-21|12-1)(-\d+)+$') { throw "Unexpected user SID: $UserSid" }
  $dir = Join-Path $env:ProgramFiles "Usage Monitor Network Helper\$UserSid"
  $exe = Join-Path $dir 'UsageMonitorNetHelper.exe'
  $taskPath = '\UsageMonitor\'
  $taskName = "NetCapture-$UserSid"
  $marker = "[usage-monitor $UserSid]"

  Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'UsageMonitorNetHelper.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $exe) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  if ($Remove) {
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-NetFirewallRule -Group 'Usage Monitor' -ErrorAction SilentlyContinue |
      Where-Object { $_.Description -and $_.Description.Contains($marker) } |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    $parent = Split-Path -Parent $dir
    if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) { Remove-Item -LiteralPath $parent -Force }
    Write-Result $true $null $null $null
    exit 0
  }

  if (-not $Source) { throw 'Missing -Source' }
  # Read once and compile from memory, so the file cannot change between hashing and compiling.
  $code = [IO.File]::ReadAllText((Join-Path $Source 'NetCapture.cs'))
  $sha = [Security.Cryptography.SHA256]::Create()
  $version = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($code))) -replace '-', '').Substring(0, 16).ToLowerInvariant()

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Compiler temp files stay inside the protected folder.
  $build = Join-Path $dir 'build'
  New-Item -ItemType Directory -Force -Path $build | Out-Null
  $env:TMP = $build
  $env:TEMP = $build
  if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe -Force }
  Add-Type -TypeDefinition $code -Language CSharp -OutputAssembly $exe -OutputType WindowsApplication -ReferencedAssemblies 'System.Core', 'Microsoft.CSharp'
  Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText((Join-Path $dir 'version.txt'), $version)

  $action = New-ScheduledTaskAction -Execute $exe -Argument "--pipe UsageMonitor.NetCapture.$UserSid --sid $UserSid" -WorkingDirectory $dir
  try {
    $account = (New-Object Security.Principal.SecurityIdentifier($UserSid)).Translate([Security.Principal.NTAccount]).Value
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
  } catch {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
  }
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Counts network bytes per app for Usage Monitor. Never reads packet contents.'
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -InputObject $task -Force | Out-Null

  # Allow this user (not other users) to start the helper when Usage Monitor launches.
  $warning = $null
  try {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $service.GetFolder('\UsageMonitor').GetTask($taskName).SetSecurityDescriptor("D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$UserSid)", 0)
  } catch {
    $warning = "The helper starts at sign-in, but Usage Monitor cannot start it on demand: $($_.Exception.Message)"
  }

  Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
  Write-Result $true $null $version $warning
  exit 0
} catch {
  Write-Result $false $_.Exception.Message $null $null
  exit 1
}
