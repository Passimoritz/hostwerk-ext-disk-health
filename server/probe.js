'use strict';
/*
 * Drive health – reading the values. Only READING commands, never anything that changes a drive:
 *   Windows: Get-PhysicalDisk + Get-StorageReliabilityCounter (PowerShell, no admin needed – without admin rights some
 *            counters are simply missing, the drive list and the health status are still there)
 *   Linux:   smartctl --scan / smartctl -j -a <device> when installed and allowed, otherwise /sys/block
 * `io` is injected ({ exec, readdir, readFile, platform }) so tests can replay recorded outputs.
 */
const path = require('path');
const H = require('./health');

// PowerShell: enums as text, every disk on its own (one disk without counters must not hide the others)
const PS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue'",
  '$out = @()',
  'foreach ($d in @(Get-PhysicalDisk)) {',
  '  $c = $null; $e = $null',
  '  try { $r = $d | Get-StorageReliabilityCounter -ErrorAction Stop',
  '    if ($r) { $c = [pscustomobject]@{ Temperature = $r.Temperature; TemperatureMax = $r.TemperatureMax; Wear = $r.Wear; PowerOnHours = $r.PowerOnHours;',
  '      ReadErrorsUncorrected = $r.ReadErrorsUncorrected; ReadErrorsTotal = $r.ReadErrorsTotal; WriteErrorsUncorrected = $r.WriteErrorsUncorrected; WriteErrorsTotal = $r.WriteErrorsTotal } }',
  '  } catch { $e = $_.Exception.Message }',
  '  $out += [pscustomobject]@{ DeviceId = $d.DeviceId; FriendlyName = $d.FriendlyName; SerialNumber = $d.SerialNumber; MediaType = [string]$d.MediaType;',
  '    BusType = [string]$d.BusType; Size = $d.Size; HealthStatus = [string]$d.HealthStatus; OperationalStatus = [string]($d.OperationalStatus -join \', \'); Counters = $c; CounterError = $e }',
  '}',
  'ConvertTo-Json -InputObject @($out) -Depth 4 -Compress',
].join('\n');

/** -EncodedCommand: no quoting problems, no .ps1 file (some systems block scripts from files). */
function psArgs(script = PS_SCRIPT) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

async function probeWindows(io) {
  const r = await io.exec('powershell.exe', psArgs(), { timeout: 90000 });
  const drives = H.parseWindows(r.stdout);
  const notes = [];
  if (!drives.length) notes.push(r.blocked ? 'blocked' : 'no-drives');
  else if (drives.some((d) => d.partial)) notes.push('needs-admin');
  return { source: 'windows', drives, notes, error: drives.length ? null : (r.stderr || '').trim().split(/\r?\n/)[0] || null };
}

/** smartctl: list devices, then read each one. null = not installed or not usable at all. */
async function probeSmartctl(io) {
  const scan = await io.exec('smartctl', ['--scan', '-j'], { timeout: 20000 });
  if (scan.error && (scan.error.code === 'ENOENT' || scan.code === 127)) return null;
  const list = H.extractJson(scan.stdout);
  const devices = list && Array.isArray(list.devices) ? list.devices.map((d) => ({ name: d.name, type: d.type })).filter((d) => /^\/dev\/[\w/.-]+$/.test(String(d.name || ''))) : [];
  if (!devices.length) return null;
  const drives = []; const failed = [];
  for (const dev of devices.slice(0, 32)) {
    const args = ['-j', '-a', dev.name];
    if (dev.type && /^[\w,-]+$/.test(dev.type)) args.splice(1, 0, '-d', dev.type);
    const r = await io.exec('smartctl', args, { timeout: 30000 });
    const d = H.parseSmartctl(H.extractJson(r.stdout), dev.name);
    if (d) drives.push(d); else failed.push(dev.name);
  }
  return { drives, failed };
}

/** /sys/block – model, size, SSD or HDD, temperature where the kernel offers it, I/O error counter. */
async function readSys(io) {
  const root = '/sys/block';
  let names = [];
  try { names = await io.readdir(root); } catch { return []; }
  const rd = async (...p) => { try { return String(await io.readFile(path.posix.join(root, ...p))).trim(); } catch { return null; } };
  const out = [];
  for (const name of names.filter((n) => /^[\w-]+$/.test(n))) {
    const e = { name, size: await rd(name, 'size'), rotational: await rd(name, 'queue', 'rotational'), removable: await rd(name, 'removable') };
    e.model = (await rd(name, 'device', 'model')) || (await rd(name, 'device', 'device', 'model'));
    e.serial = (await rd(name, 'device', 'serial')) || (await rd(name, 'device', 'device', 'serial'));
    e.ioerr = await rd(name, 'device', 'ioerr_cnt');
    // Temperature: NVMe and the drivetemp module offer a hwmon below the device
    for (const base of [['device'], ['device', 'device']]) {
      let hw = [];
      try { hw = (await io.readdir(path.posix.join(root, name, ...base))).filter((x) => /^hwmon\d*$/.test(x)); } catch { /* none */ }
      for (const h of hw) {
        let sub = [h];
        if (h === 'hwmon') { try { sub = (await io.readdir(path.posix.join(root, name, ...base, 'hwmon'))).map((x) => `hwmon/${x}`); } catch { sub = []; } }
        for (const s of sub) { const t = await rd(name, ...base, ...s.split('/'), 'temp1_input'); if (t) { e.tempMilli = t; break; } }
        if (e.tempMilli) break;
      }
      if (e.tempMilli) break;
    }
    out.push(e);
  }
  return H.parseSys(out);
}

async function probeLinux(io) {
  const smart = await probeSmartctl(io).catch(() => null);
  const sys = await readSys(io);
  if (!smart) return { source: 'sys', drives: sys, notes: [sys.length ? 'install-smartctl' : 'no-drives'], error: null };
  // Drives smartctl could not open (no rights) come from /sys – nothing disappears from the list
  // (same device or same serial = already listed; smartctl calls NVMe /dev/nvme0, /sys calls it nvme0n1)
  const have = new Set(smart.drives.map((d) => d.device));
  const serials = new Set(smart.drives.map((d) => d.serial).filter(Boolean));
  const rest = sys.filter((d) => !have.has(d.device) && !(d.serial && serials.has(d.serial)));
  const notes = smart.failed.length ? ['smartctl-rights'] : [];
  return { source: 'smartctl', drives: [...smart.drives, ...rest], notes, error: null };
}

/** Read every drive on this machine. */
async function probe(io) {
  const platform = io.platform || process.platform;
  if (platform === 'win32') return probeWindows(io);
  if (platform === 'linux') return probeLinux(io);
  const smart = await probeSmartctl(io).catch(() => null); // macOS & Co.: only with smartctl
  return smart ? { source: 'smartctl', drives: smart.drives, notes: smart.failed.length ? ['smartctl-rights'] : [], error: null } : { source: null, drives: [], notes: ['unsupported'], error: null };
}

module.exports = { probe, probeWindows, probeLinux, probeSmartctl, readSys, psArgs, PS_SCRIPT };
