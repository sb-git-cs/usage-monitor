# Read-only native power information; a single helper answers samples without repeated CIM queries.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BatteryPower {
  [StructLayout(LayoutKind.Sequential)] public struct State {
    public byte Ac, Present, Charging, Discharging, Spare0, Spare1, Spare2, Tag;
    public uint MaxCapacity, RemainingCapacity;
    public int Rate;
    public uint EstimatedTime, Alert1, Alert2;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Status {
    public byte Ac, Flags, Percent, Saver;
    public uint Life, FullLife;
  }
  [DllImport("powrprof.dll")] public static extern uint CallNtPowerInformation(int level, IntPtr input, uint inputSize, out State state, uint size);
  [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out Status status);
  public static State Read() {
    State state;
    if (CallNtPowerInformation(5, IntPtr.Zero, 0, out state, (uint)Marshal.SizeOf(typeof(State))) != 0) throw new Exception("Power information unavailable");
    return state;
  }
  public static Status ReadStatus() { Status s; if (!GetSystemPowerStatus(out s)) throw new Exception("Power status unavailable"); return s; }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq 'exit') { break }
  if ($line -ne 'sample') { continue }
  try {
    $state = [BatteryPower]::Read()
    $status = [BatteryPower]::ReadStatus()
    $pct = if ($status.Percent -le 100) { [double]$status.Percent } else { $null }
    $seconds = if ($state.Discharging -ne 0 -and $state.EstimatedTime -gt 0 -and $state.EstimatedTime -ne [uint32]::MaxValue) { [double]$state.EstimatedTime } else { $null }
    $result = @{ hasBattery = $state.Present -ne 0; percent = $pct; isCharging = $state.Charging -ne 0;
      acConnected = $state.Ac -ne 0 -and $state.Discharging -eq 0; estimatedSeconds = $seconds;
      currentCapacity = [double]$state.RemainingCapacity; powerRate = [double]$state.Rate; capacityUnit = 'mWh' }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  } catch { [Console]::Out.WriteLine('{"error":true}') }
  [Console]::Out.Flush()
}
