# Brings the visible top-level window with exactly this title to the front, restoring it if it is
# minimized. Exits 0 when it found one, 1 when there is none.
# Windows refuses SetForegroundWindow to a process that is not in the foreground; a tap of Alt first
# lets the call through.
param([Parameter(Mandatory = $true)][string]$Title)

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
  public static bool Raise(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, l) => {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(512);
      GetWindowText(hwnd, text, 512);
      if (text.ToString() != title) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);  // SW_RESTORE
    keybd_event(0x12, 0, 0, UIntPtr.Zero);       // Alt down
    keybd_event(0x12, 0, 2, UIntPtr.Zero);       // Alt up
    SetForegroundWindow(found);
    return true;
  }
}
"@

if ([RaiseWindow]::Raise($Title)) { exit 0 } else { exit 1 }
