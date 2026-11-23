# Prints what the Greenhouse worker's gate needs to know about this machine, as one line of JSON:
#   {"idleMs": <milliseconds since the last keyboard or mouse input>, "onAc": true | false | null}
# onAc is null when Windows does not know the power line's state.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Presence {
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [StructLayout(LayoutKind.Sequential)] struct PowerStatus { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public uint BatteryLifeTime; public uint BatteryFullLifeTime; }
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus status);
  public static uint IdleMs() {
    var info = new LastInput { cbSize = (uint)Marshal.SizeOf(typeof(LastInput)) };
    if (!GetLastInputInfo(ref info)) return 0;
    return unchecked(GetTickCount() - info.dwTime);
  }
  public static int AcLine() {
    PowerStatus s;
    return GetSystemPowerStatus(out s) ? s.ACLineStatus : 255;
  }
}
"@
$ac = [Presence]::AcLine()
$onAc = if ($ac -eq 1) { $true } elseif ($ac -eq 0) { $false } else { $null }
@{ idleMs = [Presence]::IdleMs(); onAc = $onAc } | ConvertTo-Json -Compress
