---
name: diagnose-frozen-bloom
description: Capture diagnostic evidence from a frozen, hung, or CPU-spinning Bloom.exe while it is still stuck — managed stacks, native stacks, the spinning thread, and the WebView2 console backlog. Use when the user says Bloom is frozen / "Not Responding" / hung / spinning, or asks why Bloom locked up. Capture FIRST, theorize after: hangs can self-resolve and the evidence decays.
user-invocable: true
---

# Diagnose a frozen Bloom

Bloom froze once for several minutes and recovered by itself while the agent was still
assembling tools. So the rule is: **capture first**. Steps 1–3 are the capture; do them
before reading code or forming theories. Do not kill the process — a dead process has no
stacks. All commands are safe against the live process (noninvasive attach).

## 0. One-time tool install (skip if already present)

```powershell
dotnet tool install -g dotnet-stack        # managed stacks
winget install Microsoft.WinDbg --accept-source-agreements --accept-package-agreements
# cdb then lives at %LOCALAPPDATA%\Microsoft\WindowsApps\cdbX64.exe
```

`(Get-Command dotnet-stack -ErrorAction SilentlyContinue)` and
`Test-Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\cdbX64.exe"` tell you whether you can
skip this. The install takes ~1–2 minutes; if the hang looks like it may not last, run
step 1 (needs nothing) and step 2's CPU probe first — they are pure PowerShell.

## 1. Find the process and confirm the state

```powershell
Get-Process Bloom | Select-Object Id, MainWindowTitle, Responding, StartTime, CPU
```

Note: `Responding` can read `True` while the title bar says "(Not Responding)" — the window
oscillates. Treat sustained CPU (step 2) and the stacks as the real evidence, not this flag.

## 2. Find the spinning thread (if CPU is high)

Diff each thread's processor time over 3 seconds:

```powershell
$p = Get-Process -Id <PID>; $t1 = @{}
foreach ($t in $p.Threads) { $t1[$t.Id] = $t.TotalProcessorTime }
Start-Sleep -Seconds 3; $p = Get-Process -Id <PID>
foreach ($t in $p.Threads) { $old = $t1[$t.Id]; if ($old -ne $null) {
  $d = ($t.TotalProcessorTime - $old).TotalMilliseconds
  if ($d -gt 50) { "{0:X} : {1} ms, state={2} wait={3}" -f $t.Id, [int]$d, $t.ThreadState, $t.WaitReason } } }
```

The thread id prints in hex; that hex id is what steps 3 and 4 take. Also check the
`msedgewebview2` children the same way (`Get-Process msedgewebview2 | Sort-Object CPU`):
a busy renderer while the host is blocked points at page JS.

## 3. Capture the stacks — the core evidence

Managed, all threads (fast, do it first):

```powershell
dotnet-stack report -p <PID> > bloom-managed-stacks.txt
```

Native stack of the interesting thread (usually the UI thread — the one whose managed
stack bottoms out in `Bloom.Program.Main`). The managed view shows blocked native calls
only as `?!?`; this is where the real answer usually is:

```powershell
$env:_NT_SYMBOL_PATH = "srv*$env:TEMP\symbols*https://msdl.microsoft.com/download/symbols"
& "$env:LOCALAPPDATA\Microsoft\WindowsApps\cdbX64.exe" -pv -p <PID> -c "~~[<HEXTID>]s; k 40; qd"
```

`-pv` is noninvasive: it suspends the process for the read and resumes it. First run is
slow (symbol download); later runs are quick. `~*k 20; qd` instead dumps every thread.

Capture twice, ~30 s apart. Identical `Child-SP` values on the top frames = one stuck
call, a true hang; changing frames = a busy loop.

## 4. Read the WebView2 console backlog

Even after the hang ends, CDP replays buffered console messages. With the go.sh launcher,
the CDP port is in `launcherControl.mjs --status --json` (`cdpPort`; also shown in Bloom's
title bar as `automation:<port>`). Open a raw websocket to each target from
`http://127.0.0.1:<cdpPort>/json/list` and send `Runtime.enable` + `Log.enable`; the
backlog arrives as `Runtime.consoleAPICalled` / `Log.entryAdded` events within a couple of
seconds. (Playwright's console listener does NOT get the backlog; use raw CDP.)

## 5. Interpret

- All managed threads idle + one thread hot in native code → the block is below .NET;
  the native stack (step 3) names it.
- `combase!CoWaitForMultipleHandles` on the UI thread inside an
  `EmbeddedBrowserWebView!...Handle*Event` frame → the WebView2 host is waiting on the
  browser process during a synchronous event handshake (seen live: `AcceleratorKeyPressed`
  during ctrl+wheel zoom). The cause is then usually on the page/browser side — check
  renderer CPU and the console backlog, not Bloom's C# first.
- `BloomServer.RequestProcessorLoop` threads all in `WaitAny` = no API request in flight;
  that rules out the sync-API-onto-blocked-UI-thread deadlock (`handleOnUiThread: true` —
  see the warning on `RegisterEndpointHandler` in `BloomApiHandler.cs`).
- A window can flip back to `Responding: True` while a COM modal wait still burns a core:
  `CoWaitForMultipleHandles` pumps some messages while it waits.

## 6. Report

Give the user: the stuck thread's native stack (top ~10 frames), what it rules out, the
suspect side (host C# vs page JS vs WebView2 handshake), and the raw capture files. Ask
what the user was doing at the moment of the freeze — the triggering gesture (a keystroke,
ctrl+wheel, a paste) usually names the code path.
