# Brings a window to the front, restoring it if it is minimized: the visible top-level window with
# exactly the title -Title, or the main window of the process named -Process (e.g. Orca). Exits 0
# when it found one, 1 when there is none.
# Windows refuses SetForegroundWindow to a process that is not in the foreground; a tap of Alt first
# lets the call through.
param([string]$Title, [string]$Process)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RaiseWindow {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, l) => {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(512);
      GetWindowText(hwnd, text, 512);
      if (text.ToString() != title) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Raise(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);  // SW_RESTORE
    keybd_event(0x12, 0, 0, UIntPtr.Zero);     // Alt down
    keybd_event(0x12, 0, 2, UIntPtr.Zero);     // Alt up
    SetForegroundWindow(hwnd);
    return true;
  }
}
"@

$hwnd = [IntPtr]::Zero
if ($Title) { $hwnd = [RaiseWindow]::Find($Title) }
elseif ($Process) {
  $p = Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if ($p) { $hwnd = $p.MainWindowHandle }
}
if ([RaiseWindow]::Raise($hwnd)) { exit 0 } else { exit 1 }
