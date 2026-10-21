'use strict';
/*
 * Drive health – reading with administrator rights. Windows reveals temperature, wear and error counters only to
 * administrators, smartctl needs them for most drives everywhere. Hostwerk itself keeps running WITHOUT them; these
 * scripts run through Hostwerk's own way for admin commands (host.core('platform').elevatedBatch, SDK 2.10):
 *
 *   checkScript()   one Windows prompt: Get-PhysicalDisk + Get-StorageReliabilityCounter (+ smartctl when installed),
 *                   prints <<<DH{json}DH>>> – parsed by health.parseAdminResult
 *   installScript() one Windows prompt: Windows task "\Hostwerk\DiskHealth" (SYSTEM, hourly + at start) that runs ONLY
 *                   taskScript() – the same reading – and writes the result to %ProgramData%\HostwerkDiskHealth\smart.json.
 *                   Hostwerk reads that file without admin rights. The folder belongs to the administrators (users may
 *                   only read), so nobody without admin rights can swap the script the task runs.
 *   removeScript()  one Windows prompt: task and folder gone (switch off, or "Remove what was set up")
 *
 * The task cleans up after itself when the extension is gone (uninstalled, Hostwerk removed): it checks the extension's
 * manifest and – missing twice in two minutes – removes itself and its folder. Nothing in it ever writes to a drive.
 * Linux: smartctl through pkexec (one password prompt) – see linuxSteps().
 */
const path = require('path');
const { MARK_START, MARK_END } = require('./health');
const { DISK_LINES } = require('./probe');

const TASK_NAME = 'DiskHealth';
const TASK_FOLDER = '\\Hostwerk\\';
const TASK_DIR = 'HostwerkDiskHealth';
const TASK_FILE = 'smart.json';
/** The task reads every hour – S.M.A.R.T. values change slowly, the regular check (without admin) watches the health in between. */
const TASK_INTERVAL_MIN = 60;
/** smartctl 7.0 brought the JSON output (-j). */
const SMARTCTL_MIN = [7, 0];
const WINGET_ID = 'smartmontools.smartmontools';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Folder of the task (admin-only, users read): %ProgramData%\HostwerkDiskHealth */
function taskDir(env = process.env) { return path.win32.join(env.ProgramData || env.ALLUSERSPROFILE || 'C:\\ProgramData', TASK_DIR); }
function taskFile(env = process.env) { return path.win32.join(taskDir(env), TASK_FILE); }

/**
 * smartctl may only run with admin rights from a place only administrators can change (Program Files) – otherwise any
 * program of the user could replace it and get admin rights on the next check.
 */
function trustedSmartctl(p, env = process.env) {
  if (!p || !path.win32.isAbsolute(p) || /\.\./.test(p) || !/\\smartctl\.exe$/i.test(p)) return false;
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((r) => path.win32.normalize(r).toLowerCase().replace(/\\$/, ''));
  const n = path.win32.normalize(p).toLowerCase();
  return roots.some((r) => n.startsWith(`${r}\\`));
}

/** "smartctl 7.4 2023-08-01 r5530 [x86_64-w64-mingw32-w10-b19045] (sf-7.4-1)" → '7.4' */
function parseVersion(text) { const m = String(text || '').match(/smartctl\s+(\d+)\.(\d+)/i); return m ? `${m[1]}.${m[2]}` : null; }
function versionOk(v) { if (!v) return false; const [a, b] = v.split('.').map(Number); return a > SMARTCTL_MIN[0] || (a === SMARTCTL_MIN[0] && b >= SMARTCTL_MIN[1]); }

/** PowerShell lines: drives (DISK_LINES → $out), smartctl per device (→ $smart), everything as ASCII-safe JSON in $json. */
function collectLines(smartctl) {
  return [
    ...DISK_LINES,
    '$smart = @()',
    `$sc = ${q(smartctl || '')}`,
    'if ($sc -and (Test-Path -LiteralPath $sc)) {',
    '  $devs = @(); try { $scan = (& $sc --scan-open -j 2>$null | Out-String) | ConvertFrom-Json; if ($scan.devices) { $devs = @($scan.devices) } } catch { }',
    '  foreach ($dv in ($devs | Select-Object -First 32)) {',
    '    $n = [string]$dv.name; $ty = [string]$dv.type',
    "    if ($n -notmatch '^/dev/[\\w/.-]+$') { continue }",
    "    $a = @('-j', '-a'); if ($ty -match '^[\\w,-]+$') { $a += @('-d', $ty) }; $a += $n",
    '    $smart += [pscustomobject]@{ device = $n; type = $ty; json = (& $sc @a 2>$null | Out-String) }',
    '  }',
    '}',
    '$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '$res = [pscustomobject]@{ v = 1; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); admin = $isAdmin; disks = @($out); smart = @($smart) }',
    '$json = ConvertTo-Json -InputObject $res -Depth 6 -Compress',
    // Umlaute & Co. als \uXXXX – die Ausgabe geht durch Dateien mit wechselnder Kodierung
    "$json = [regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })",
  ];
}

/** One administrator check: prints the result between the markers. */
function checkScript({ smartctl } = {}) {
  return [...collectLines(smartctl), `Write-Output ('${MARK_START}' + $json + '${MARK_END}')`].join('\r\n');
}

/** Removing task and folder – shared by removeScript() and the task's own clean-up. rd /s does not follow junctions. */
function removeLines(dir) {
  return [
    `Unregister-ScheduledTask -TaskName ${q(TASK_NAME)} -TaskPath ${q(TASK_FOLDER)} -Confirm:$false -ErrorAction SilentlyContinue`,
    `if (Test-Path -LiteralPath ${q(dir)}) { & cmd.exe /d /c rd /s /q ${q(dir)} }`,
    // Den Ordner „Hostwerk“ in der Aufgabenplanung nur entfernen, wenn er leer ist (der Systemdienst liegt nicht darin)
    "try { $ts = New-Object -ComObject Schedule.Service; $ts.Connect(); $f = $ts.GetFolder('\\Hostwerk'); if ($f.GetTasks(1).Count -eq 0 -and $f.GetFolders(0).Count -eq 0) { $ts.GetFolder('\\').DeleteFolder('Hostwerk', 0) } } catch { }",
  ];
}

/**
 * What the Windows task runs (as SYSTEM): first check that the extension still exists (otherwise clean up and stop),
 * then the same reading as checkScript(), written atomically to smart.json.
 */
function taskScript({ smartctl, marker, dir }) {
  const file = path.win32.join(dir, TASK_FILE);
  const lines = [];
  if (marker) {
    lines.push(
      `if (-not (Test-Path -LiteralPath ${q(marker)})) {`,
      '  Start-Sleep -Seconds 120',
      `  if (-not (Test-Path -LiteralPath ${q(marker)})) {`,
      ...removeLines(dir).map((l) => `    ${l}`),
      '    exit 0',
      '  }',
      '}',
    );
  }
  lines.push(
    ...collectLines(smartctl),
    `$file = ${q(file)}; $tmp = $file + '.tmp'`,
    `[IO.File]::WriteAllText($tmp, '${MARK_START}' + $json + '${MARK_END}', (New-Object System.Text.UTF8Encoding $false))`,
    'Move-Item -LiteralPath $tmp -Destination $file -Force',
  );
  return lines.join('\r\n');
}

/** Set up the task (one administrator prompt). Prints <<<DH{"ok":true}DH>>> or the error. */
function installScript({ smartctl, marker, dir, intervalMin = TASK_INTERVAL_MIN }) {
  const probe = path.win32.join(dir, 'probe.ps1');
  const minutes = Math.max(15, Math.min(1440, Math.round(Number(intervalMin) || TASK_INTERVAL_MIN)));
  return [
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    'try {',
    `  $dir = ${q(dir)}`,
    // Ein vorhandener Ordner (alter Stand oder von jemand anderem angelegt) kommt weg – rd folgt keinen Verknüpfungen
    `  if (Test-Path -LiteralPath $dir) { & cmd.exe /d /c rd /s /q ${q(dir)} }`,
    '  New-Item -ItemType Directory -Path $dir -Force | Out-Null',
    // Besitzer: Administratoren. Schreiben dürfen nur SYSTEM und Administratoren, Benutzer nur lesen
    "  & icacls.exe $dir /setowner '*S-1-5-32-544' | Out-Null",
    "  & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }",
    `  [IO.File]::WriteAllText(${q(probe)}, ${q(taskScript({ smartctl, marker, dir }))}, (New-Object System.Text.UTF8Encoding $true))`,
    `  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${q(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${probe}"`)}`,
    `  $trg = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${minutes})))`,
    "  $pr = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    '  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew',
    `  Register-ScheduledTask -TaskName ${q(TASK_NAME)} -TaskPath ${q(TASK_FOLDER)} -Action $act -Trigger $trg -Principal $pr -Settings $set -Description ${q('Hostwerk drive health: only reads S.M.A.R.T. values (temperature, wear, errors) and writes them to this folder. Switch off in Hostwerk (Drive health).')} -Force | Out-Null`,
    `  Start-ScheduledTask -TaskName ${q(TASK_NAME)} -TaskPath ${q(TASK_FOLDER)}`,
    `  Write-Output '${MARK_START}{"ok":true}${MARK_END}'`,
    '} catch {',
    `  Write-Output ('${MARK_START}' + (ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress) + '${MARK_END}'); exit 1`,
    '}',
  ].join('\r\n');
}

/** Remove task and folder (one administrator prompt). */
function removeScript({ dir }) {
  return ["$ErrorActionPreference = 'SilentlyContinue'", ...removeLines(dir), `Write-Output '${MARK_START}{"ok":true}${MARK_END}'`].join('\r\n');
}

/** powershell.exe arguments for a script: -EncodedCommand (no quoting problems, no .ps1 file the user could change). */
function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** {"ok":…} between the markers of install/remove → { ok, error } */
function parseOk(text) {
  const s = String(text || '');
  const a = s.indexOf(MARK_START); const b = s.lastIndexOf(MARK_END);
  if (a < 0 || b <= a) return { ok: false, error: null };
  try { const j = JSON.parse(s.slice(a + MARK_START.length, b)); return { ok: j.ok === true, error: j.error || null }; } catch { return { ok: false, error: null }; }
}

/**
 * Linux: one pkexec prompt, smartctl for every device. `devices` from `smartctl --scan -j` (works without root);
 * names and types are checked – nothing from outside reaches the command line unchecked.
 */
function linuxSteps(devices) {
  return (devices || []).filter((d) => d && /^\/dev\/[\w/.-]+$/.test(String(d.name || ''))).slice(0, 32).map((d) => {
    const args = ['-j', '-a', d.name];
    if (d.type && /^[\w,-]+$/.test(d.type)) args.splice(1, 0, '-d', d.type);
    return { cmd: 'smartctl', args };
  });
}

/** Where smartmontools usually lands on Windows (official installer and winget). */
function smartctlCandidates(env = process.env) {
  return [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((r) => path.win32.join(r, 'smartmontools', 'bin', 'smartctl.exe'));
}

module.exports = {
  TASK_NAME, TASK_FOLDER, TASK_DIR, TASK_FILE, TASK_INTERVAL_MIN, WINGET_ID, SMARTCTL_MIN,
  taskDir, taskFile, trustedSmartctl, parseVersion, versionOk, checkScript, taskScript, installScript, removeScript, psArgs, parseOk, linuxSteps, smartctlCandidates,
};
