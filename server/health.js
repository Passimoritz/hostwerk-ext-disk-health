'use strict';
/*
 * Drive health – pure logic without Hostwerk (tested with recorded outputs in tests/).
 *
 *   parseWindows(text|list)     → drives from the PowerShell probe (Get-PhysicalDisk + Get-StorageReliabilityCounter)
 *   parseSmartctl(json, device) → one drive from `smartctl -j -a <device>` (ATA/SATA, NVMe, USB bridges)
 *   parseSys(entries)           → drives from /sys/block (Linux without smartctl or without the rights for it)
 *   parseUdisks(json)           → S.M.A.R.T. values udisks offers without root (busctl --json=short … GetManagedObjects)
 *   parseAdminResult(text)      → { at, drives } from the administrator check (button or Windows task)
 *   matchDrives(base, extra)    → one list: values from a richer source fill the gaps of the basic one
 *   assess(drive, prev, limits) → { level, problems } – current values and growth since the previous sample
 *   estimateLife(drive, hist)   → { years, basis } – rough remaining life of an SSD from its wear
 *
 * Every drive has the same shape; values the source does not know stay null (never 0 – "unknown" is not "no errors").
 */

/** Counters that only ever grow on a healthy drive if something is wrong – growth is reported. */
const COUNTERS = ['readErrors', 'writeErrors', 'reallocated', 'pending', 'uncorrectable', 'mediaErrors', 'crcErrors', 'ioErrors'];
/** Growth of these means the surface or the flash is failing → error; the others are a warning (cable, controller …). */
const SEVERE = new Set(['reallocated', 'pending', 'uncorrectable', 'mediaErrors']);
/** Markers around the JSON of the administrator check – stderr of the elevated run may surround it. */
const MARK_START = '<<<DH';
const MARK_END = 'DH>>>';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const clampPct = (v) => (v === null ? null : Math.max(0, Math.min(100, Math.round(v))));

function blank(extra) {
  return {
    id: '', name: '', serial: null, media: 'unknown', bus: null, sizeBytes: null, health: null, status: null, firmware: null,
    tempC: null, tempMaxC: null, wearPct: null, powerOnHours: null, spareLow: false, spareLeftPct: null, spareThresholdPct: null, criticalWarning: null,
    readErrors: null, writeErrors: null, reallocated: null, pending: null, uncorrectable: null, mediaErrors: null, crcErrors: null, ioErrors: null,
    dataWrittenBytes: null, dataReadBytes: null, powerCycles: null, unsafeShutdowns: null,
    attributes: null, source: null, partial: false, note: null, ...extra,
  };
}

/** First JSON value in a text – PowerShell may print a BOM, warnings or progress before it. */
function extractJson(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/* ---------------- Windows ---------------- */
// Get-PhysicalDisk enums arrive as text ([string]) from our probe – numbers are accepted as well (older PowerShell / ConvertTo-Json without cast)
const WIN_MEDIA = { 0: 'unknown', 3: 'hdd', 4: 'ssd', 5: 'ssd', HDD: 'hdd', SSD: 'ssd', SCM: 'ssd', Unspecified: 'unknown' };
const WIN_BUS = { 1: 'SCSI', 3: 'ATA', 6: 'Fibre Channel', 7: 'USB', 8: 'RAID', 10: 'SAS', 11: 'SATA', 12: 'SD', 13: 'MMC', 15: 'File-backed', 16: 'Storage Spaces', 17: 'NVMe' };
const WIN_HEALTH = { 0: 'healthy', 1: 'warning', 2: 'unhealthy', 5: 'unknown', Healthy: 'healthy', Warning: 'warning', Unhealthy: 'unhealthy', Unknown: 'unknown' };
/** Counters of Get-StorageReliabilityCounter shown in the details table (in this order). */
const WIN_FIELDS = ['Temperature', 'TemperatureMax', 'Wear', 'PowerOnHours', 'ReadErrorsUncorrected', 'ReadErrorsCorrected', 'ReadErrorsTotal',
  'WriteErrorsUncorrected', 'WriteErrorsCorrected', 'WriteErrorsTotal', 'StartStopCycleCount', 'LoadUnloadCycleCount'];

/**
 * Output of the PowerShell probe: [{ DeviceId, FriendlyName, SerialNumber, MediaType, BusType, Size, HealthStatus,
 * OperationalStatus, Counters: { Temperature, TemperatureMax, Wear, PowerOnHours, ReadErrorsUncorrected, … } | null, CounterError }]
 */
function parseWindows(input) {
  let list = Array.isArray(input) || (input && typeof input === 'object') ? input : extractJson(input);
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  return list.filter((d) => d && typeof d === 'object').map((d) => {
    const c = d.Counters && typeof d.Counters === 'object' ? d.Counters : null;
    const bus = WIN_BUS[d.BusType] || (typeof d.BusType === 'string' && d.BusType ? d.BusType : null);
    let media = WIN_MEDIA[d.MediaType] || 'unknown';
    if (bus === 'NVMe' && media !== 'hdd') media = 'nvme';
    const serial = typeof d.SerialNumber === 'string' && d.SerialNumber.trim() ? d.SerialNumber.trim().replace(/\.$/, '') : null;
    const temp = c ? num(c.Temperature) : null;
    const tmax = c ? num(c.TemperatureMax) : null;
    // Wear 0 is also what drives report that do not know it – only trust it on SSDs
    const wear = c ? num(c.Wear) : null;
    const attributes = c ? WIN_FIELDS.filter((k) => num(c[k]) !== null).map((k) => ({ key: `win:${k}`, label: k, value: num(c[k]) })) : null;
    return blank({
      id: serial || `win-${d.DeviceId}`,
      name: String(d.FriendlyName || `Disk ${d.DeviceId}`).trim(),
      serial, media, bus,
      sizeBytes: num(d.Size),
      health: WIN_HEALTH[d.HealthStatus] || null,
      status: typeof d.OperationalStatus === 'string' && d.OperationalStatus ? d.OperationalStatus : null,
      // 0 °C means "not reported" on many controllers
      tempC: temp ? temp : null,
      tempMaxC: tmax ? tmax : null,
      wearPct: wear !== null && media !== 'hdd' ? clampPct(wear) : null,
      powerOnHours: c ? num(c.PowerOnHours) : null,
      readErrors: c ? num(c.ReadErrorsUncorrected) : null,
      writeErrors: c ? num(c.WriteErrorsUncorrected) : null,
      powerCycles: c ? num(c.StartStopCycleCount) : null,
      attributes: attributes && attributes.length ? attributes : null,
      source: 'windows',
      partial: !c,
      note: c ? null : 'counters-unavailable',
    });
  });
}

/* ---------------- smartctl (Linux, Windows with smartmontools, macOS) ---------------- */
const attr = (table, id) => (Array.isArray(table) ? table.find((a) => a && a.id === id) : null) || null;
const rawOf = (a) => (a && a.raw ? num(a.raw.value) : null);
/** Fields of the NVMe health log shown in the details table (in this order). */
const NVME_FIELDS = ['critical_warning', 'temperature', 'available_spare', 'available_spare_threshold', 'percentage_used', 'data_units_read', 'data_units_written',
  'host_reads', 'host_writes', 'controller_busy_time', 'power_cycles', 'power_on_hours', 'unsafe_shutdowns', 'media_errors', 'num_err_log_entries', 'warning_temp_time', 'critical_comp_time'];

/** One drive from `smartctl -j -a <device>`. Returns null when smartctl could not open the device (no rights, gone). */
function parseSmartctl(j, device) {
  if (!j || typeof j !== 'object') return null;
  const exit = j.smartctl && num(j.smartctl.exit_status);
  // Bit 1: device open failed (e.g. no permission) – nothing usable in the answer
  if (exit !== null && exit & 2 && !j.model_name && !j.serial_number) return null;
  const type = String((j.device && (j.device.protocol || j.device.type)) || '').toLowerCase();
  const nvme = type.includes('nvme') || !!j.nvme_smart_health_information_log;
  const rot = num(j.rotation_rate);
  const serial = j.serial_number ? String(j.serial_number).trim() : null;
  const d = blank({
    id: serial || `dev-${device}`,
    name: String(j.model_name || j.model_family || device || 'Drive').trim(),
    serial,
    firmware: j.firmware_version ? String(j.firmware_version).trim() : null,
    media: nvme ? 'nvme' : rot === 0 ? 'ssd' : rot > 0 ? 'hdd' : 'unknown',
    bus: nvme ? 'NVMe' : (j.device && j.device.protocol) || null,
    sizeBytes: j.user_capacity ? num(j.user_capacity.bytes) : j.nvme_total_capacity ? num(j.nvme_total_capacity) : null,
    health: j.smart_status && typeof j.smart_status.passed === 'boolean' ? (j.smart_status.passed ? 'healthy' : 'unhealthy') : null,
    tempC: j.temperature ? num(j.temperature.current) : null,
    powerOnHours: j.power_on_time ? num(j.power_on_time.hours) : null,
    powerCycles: num(j.power_cycle_count),
    source: 'smartctl',
    device: device || (j.device && j.device.name) || null,
  });
  // USB bridges (SAT) tell smartctl how they are connected
  if (j.device && /^(sat|usb)/i.test(String(j.device.type || '')) && /usb/i.test(String(j.device.info_name || ''))) d.bus = 'USB';
  if (nvme) {
    const l = j.nvme_smart_health_information_log || {};
    if (d.tempC === null) d.tempC = num(l.temperature);
    if (d.powerOnHours === null) d.powerOnHours = num(l.power_on_hours);
    if (d.powerCycles === null) d.powerCycles = num(l.power_cycles);
    d.wearPct = clampPct(num(l.percentage_used));
    d.mediaErrors = num(l.media_errors);
    d.criticalWarning = num(l.critical_warning);
    d.unsafeShutdowns = num(l.unsafe_shutdowns);
    const spare = num(l.available_spare); const thr = num(l.available_spare_threshold);
    d.spareLeftPct = spare; d.spareThresholdPct = thr;
    d.spareLow = spare !== null && thr !== null && thr > 0 && spare < thr;
    // One data unit = 1000 blocks of 512 bytes
    if (num(l.data_units_written) !== null) d.dataWrittenBytes = num(l.data_units_written) * 512000;
    if (num(l.data_units_read) !== null) d.dataReadBytes = num(l.data_units_read) * 512000;
    const list = NVME_FIELDS.filter((k) => num(l[k]) !== null).map((k) => ({ key: `nvme:${k}`, label: k, value: num(l[k]) }));
    d.attributes = list.length ? list : null;
    if (j.nvme_smart_health_information_log === undefined) d.partial = true;
  } else {
    const t = j.ata_smart_attributes && j.ata_smart_attributes.table;
    d.reallocated = rawOf(attr(t, 5));
    d.pending = rawOf(attr(t, 197));
    d.uncorrectable = rawOf(attr(t, 198));
    d.crcErrors = rawOf(attr(t, 199));
    const r187 = rawOf(attr(t, 187)); // Reported_Uncorrect
    if (r187 !== null) d.readErrors = r187;
    if (d.tempC === null) { const a = attr(t, 194) || attr(t, 190); const raw = rawOf(a); if (raw !== null) d.tempC = raw > 200 ? raw & 0xff : raw; }
    if (d.powerCycles === null) d.powerCycles = rawOf(attr(t, 12));
    if (d.powerOnHours === null) d.powerOnHours = rawOf(attr(t, 9));
    d.unsafeShutdowns = rawOf(attr(t, 192)) ?? rawOf(attr(t, 174));
    // Total_LBAs_Written: blocks of the logical sector size (most drives; a few count in 32 MiB units – those name it so)
    const lbaW = attr(t, 241); const lbaR = attr(t, 242);
    const block = num(j.logical_block_size) || 512;
    const unit = (a) => (a && /32MiB|_32MiB|GiB/i.test(String(a.name || '')) ? (/GiB/i.test(a.name) ? 1073741824 : 33554432) : block);
    if (rawOf(lbaW) !== null) d.dataWrittenBytes = rawOf(lbaW) * unit(lbaW);
    if (rawOf(lbaR) !== null) d.dataReadBytes = rawOf(lbaR) * unit(lbaR);
    // SSD wear: normalised "life left" attributes count down from 100
    const life = [231, 233, 177, 202, 169].map((id) => attr(t, id)).find((a) => a && num(a.value) !== null);
    if (life && d.media !== 'hdd') d.wearPct = clampPct(100 - num(life.value));
    if (Array.isArray(t)) {
      d.attributes = t.filter((a) => a && num(a.id) !== null).map((a) => ({
        key: `ata:${a.id}`, id: a.id, label: String(a.name || `Attribute ${a.id}`).replace(/_/g, ' '),
        value: a.raw && a.raw.string !== undefined ? String(a.raw.string) : rawOf(a), norm: num(a.value), worst: num(a.worst), thresh: num(a.thresh),
        failing: !!(a.when_failed && String(a.when_failed).trim() && String(a.when_failed).trim() !== '-'),
      }));
    }
    if (!t) d.partial = true;
  }
  return d;
}

/* ---------------- /sys/block (Linux fallback) ---------------- */
/**
 * entries: [{ name: 'sda', model, serial, size (512-byte sectors), rotational: '0'|'1', removable, tempMilli, ioerr (hex text) }]
 * Read-only, works without root – but there are no S.M.A.R.T. values here (only temperature where the kernel offers it).
 */
function parseSys(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && e.name && !/^(loop|ram|zram|dm-|md|sr|fd|nbd)/.test(e.name)).map((e) => {
    const nvme = /^nvme/.test(e.name);
    const sectors = num(e.size);
    const milli = num(e.tempMilli);
    const io = e.ioerr !== undefined && e.ioerr !== null ? parseInt(String(e.ioerr).trim(), 16) : NaN;
    const serial = e.serial ? String(e.serial).trim() : null;
    return blank({
      id: serial || `sys-${e.name}`,
      name: String(e.model || e.name).trim(),
      serial,
      media: nvme ? 'nvme' : String(e.rotational).trim() === '1' ? 'hdd' : String(e.rotational).trim() === '0' ? 'ssd' : 'unknown',
      bus: nvme ? 'NVMe' : String(e.removable).trim() === '1' ? 'USB' : null,
      sizeBytes: sectors !== null ? sectors * 512 : null,
      tempC: milli !== null && milli > 0 ? Math.round(milli / 1000) : null,
      ioErrors: Number.isFinite(io) ? io : null,
      device: `/dev/${e.name}`,
      source: 'sys',
      partial: true,
      note: 'no-smart',
    });
  }).filter((d) => d.sizeBytes === null || d.sizeBytes > 0);
}

/* ---------------- udisks (Linux, without root) ---------------- */
/**
 * `busctl --json=short call org.freedesktop.UDisks2 /org/freedesktop/UDisks2 org.freedesktop.DBus.ObjectManager GetManagedObjects`
 * → { type, data: [ { "/org/…/drives/X": { "org.freedesktop.UDisks2.Drive": { Model: { type, data }, … }, "….Drive.Ata": { … } } } ] }
 * udisks reads S.M.A.R.T. itself (as root) and offers the summary to everyone: temperature, power-on time, failing, bad sectors.
 */
function parseUdisks(j) {
  const objs = j && Array.isArray(j.data) ? j.data[0] : j && j.data && typeof j.data === 'object' ? j.data : null;
  if (!objs || typeof objs !== 'object') return [];
  const val = (ifc, k) => (ifc && ifc[k] && typeof ifc[k] === 'object' && 'data' in ifc[k] ? ifc[k].data : ifc ? ifc[k] : undefined);
  const out = [];
  for (const [p, ifaces] of Object.entries(objs)) {
    if (!/\/drives\//.test(p) || !ifaces || typeof ifaces !== 'object') continue;
    const drv = ifaces['org.freedesktop.UDisks2.Drive'];
    if (!drv) continue;
    const ata = ifaces['org.freedesktop.UDisks2.Drive.Ata'];
    const nv = ifaces['org.freedesktop.UDisks2.NVMe.Controller'];
    const serial = String(val(drv, 'Serial') || '').trim() || null;
    const kelvin = (k) => (num(k) !== null && num(k) > 200 ? Math.round(num(k) - 273.15) : null);
    const d = blank({
      id: serial || `udisks-${p.split('/').pop()}`,
      name: String(val(drv, 'Model') || p.split('/').pop()).trim(),
      serial,
      sizeBytes: num(val(drv, 'Size')),
      media: nv ? 'nvme' : val(drv, 'Rotational') === true ? 'hdd' : val(drv, 'Rotational') === false ? 'ssd' : 'unknown',
      bus: nv ? 'NVMe' : String(val(drv, 'ConnectionBus') || '') === 'usb' ? 'USB' : null,
      source: 'udisks',
      partial: true,
    });
    if (ata && val(ata, 'SmartEnabled') !== false && num(val(ata, 'SmartUpdated'))) {
      d.tempC = kelvin(val(ata, 'SmartTemperature'));
      const secs = num(val(ata, 'SmartPowerOnSeconds'));
      d.powerOnHours = secs ? Math.round(secs / 3600) : null;
      d.health = val(ata, 'SmartFailing') === true ? 'unhealthy' : 'healthy';
      const bad = num(val(ata, 'SmartNumBadSectors'));
      if (bad !== null && bad >= 0) d.reallocated = bad;
    }
    if (nv && num(val(nv, 'SmartUpdated'))) {
      d.tempC = kelvin(val(nv, 'SmartTemperature'));
      d.powerOnHours = num(val(nv, 'SmartPowerOnHours'));
      const cw = val(nv, 'SmartCriticalWarning');
      d.health = Array.isArray(cw) && cw.length ? 'warning' : 'healthy';
      if (Array.isArray(cw) && cw.length) d.criticalWarning = cw.length;
    }
    out.push(d);
  }
  return out;
}

/* ---------------- Combining sources ---------------- */
const HEALTH_RANK = { unhealthy: 3, warning: 2, healthy: 1, unknown: 0 };
const normSerial = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normModel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sameSize = (a, b) => a === null || b === null || Math.abs(a - b) / Math.max(a, b) < 0.02;
/** Windows shows NVMe serials as an EUI-64 like 0000_0000_…_50C6_8E52 – not the serial on the label. */
const SMARTCTL_WINS = new Set([...COUNTERS, 'wearPct', 'tempC', 'powerOnHours']);
const looksLikeEui =(s) => /^[0-9A-F]{4}(_[0-9A-F]{4}){3,}$/i.test(String(s || ''));

/** Fill the gaps of `base` with the values of `extra` (same drive, richer source). id and history stay with `base`. */
function mergeDrive(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined || k === 'id' || k === 'source') continue;
    if (k === 'partial' || k === 'note' || k === 'spareLow' || k === 'tempStale') continue;
    if (k === 'health') { if ((HEALTH_RANK[v] || 0) > (HEALTH_RANK[out.health] || 0)) out.health = v; continue; }
    if (k === 'attributes') { out.attributes = extra.source === 'smartctl' || !out.attributes ? v : out.attributes; continue; }
    if (k === 'serial') { if (!out.serial || looksLikeEui(out.serial)) out.serial = v; continue; }
    if (k === 'media') { if (out.media === 'unknown') out.media = v; continue; }
    if (k === 'name') { if (!out.name) out.name = v; continue; }
    // smartctl reads the drive itself – its counters, wear and temperature win over Windows' summary (which reports
    // wear 0 for SATA SSDs it does not understand)
    if (out[k] === null || out[k] === undefined || (extra.source === 'smartctl' && SMARTCTL_WINS.has(k))) out[k] = v;
  }
  // An old temperature only counts as old when it really came from the older source
  out.tempStale = base.tempC === null || base.tempC === undefined ? !!(extra.tempC !== null && extra.tempC !== undefined && extra.tempStale) : !!base.tempStale;
  out.spareLow = !!(base.spareLow || extra.spareLow);
  out.partial = !!(base.partial && extra.partial);
  out.note = out.partial ? base.note : null;
  return out;
}

/**
 * Join two lists of drives (e.g. Windows + smartctl, /sys + udisks): same serial, otherwise same model and size, otherwise
 * the only unmatched drive of the same kind. Drives only the richer source knows are added at the end.
 */
function matchDrives(base, extra) {
  const left = [...base];
  const used = new Set();
  const take = (pred) => { const i = left.findIndex((b, n) => !used.has(n) && pred(b)); if (i >= 0) used.add(i); return i; };
  const pending = [];
  for (const e of extra || []) {
    let i = e.serial ? take((b) => b.serial && normSerial(b.serial) === normSerial(e.serial)) : -1;
    if (i < 0) i = take((b) => normModel(b.name) && normModel(b.name) === normModel(e.name) && sameSize(b.sizeBytes, e.sizeBytes));
    if (i < 0) { pending.push(e); continue; }
    left[i] = mergeDrive(left[i], e);
  }
  const added = [];
  for (const e of pending) {
    const kind = (d) => (d.media === 'nvme' ? 'nvme' : 'other');
    const free = left.map((b, n) => n).filter((n) => !used.has(n) && kind(left[n]) === kind(e) && sameSize(left[n].sizeBytes, e.sizeBytes));
    const same = pending.filter((x) => kind(x) === kind(e));
    if (free.length === 1 && same.length === 1) { used.add(free[0]); left[free[0]] = mergeDrive(left[free[0]], e); } else added.push(e);
  }
  return [...left, ...added];
}

/**
 * Result of the administrator check (one elevated PowerShell run, the Windows task or Linux pkexec):
 *   <<<DH{ "v": 1, "at": ms, "admin": true, "disks": [ …PowerShell probe… ], "smart": [{ device, type, json: "<smartctl -j -a>" }] }DH>>>
 * → { at, admin, drives, smartctl } or null when nothing usable came back (aborted, denied).
 */
function parseAdminResult(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const a = s.indexOf(MARK_START); const b = s.lastIndexOf(MARK_END);
  const j = a >= 0 && b > a ? (() => { try { return JSON.parse(s.slice(a + MARK_START.length, b)); } catch { return null; } })() : extractJson(s);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const at = num(j.at) || null;
  const base = j.disks ? parseWindows(j.disks) : [];
  const smart = (Array.isArray(j.smart) ? j.smart : []).map((x) => x && parseSmartctl(typeof x.json === 'string' ? extractJson(x.json) : x.json, x.device)).filter(Boolean);
  const drives = (base.length ? matchDrives(base, smart) : smart).map((d) => ({ ...d, smartAt: at }));
  if (!drives.length) return null;
  return { at, admin: j.admin !== false, drives, smartctl: smart.length > 0 };
}

/* ---------------- Assessment ---------------- */
const DEFAULT_LIMITS = { tempWarn: 60, tempCrit: 70, wearWarn: 80, wearCrit: 95 };
const limitsOf = (limits) => ({ ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits || {}).filter(([, v]) => Number.isFinite(v))) });

/** Temperature as traffic light: 'ok' | 'warn' | 'err' | null (unknown). Drive's own limit wins, but never above ours + 15 °C. */
function tempLevel(d, limits) {
  if (!d || d.tempC === null || d.tempC === undefined) return null;
  const L = limitsOf(limits);
  const crit = d.tempMaxC ? Math.min(d.tempMaxC, L.tempCrit + 15) : L.tempCrit;
  if (d.tempC >= crit) return 'err';
  if (d.tempC >= Math.min(L.tempWarn, crit - 1)) return 'warn';
  return 'ok';
}

/**
 * Problems of one drive: health status, temperature, wear, spare, failing attributes and counters that grew since `prev`
 * (the last stored sample of the same drive). Each problem: { code, level: 'warn'|'err', value, before? }.
 * A temperature from an old administrator check (tempStale) is not judged – it says nothing about now.
 */
function assess(d, prev, limits = {}) {
  const L = limitsOf(limits);
  const problems = [];
  const add = (code, level, value, before) => problems.push({ code, level, value: value === undefined ? null : value, ...(before !== undefined ? { before } : {}) });
  if (d.health === 'unhealthy') add('health', 'err', d.health);
  else if (d.health === 'warning') add('health', 'warn', d.health);
  if (d.criticalWarning) add('critical', 'err', d.criticalWarning);
  if (d.spareLow) add('spare', 'err');
  const tl = d.tempStale ? null : tempLevel(d, L);
  if (tl === 'err' || tl === 'warn') add('temp', tl, d.tempC);
  if (d.wearPct !== null && d.wearPct !== undefined) {
    if (d.wearPct >= L.wearCrit) add('wear', 'err', d.wearPct);
    else if (d.wearPct >= L.wearWarn) add('wear', 'warn', d.wearPct);
  }
  if (d.pending) add('pending', 'warn', d.pending);
  const failing = (d.attributes || []).filter((a) => a.failing).map((a) => a.label);
  if (failing.length) add('attr', 'err', failing.join(', '));
  for (const k of COUNTERS) {
    const now = d[k]; const before = prev ? prev[k] : null;
    if (now === null || now === undefined || before === null || before === undefined || now <= before) continue;
    add(`grow:${k}`, SEVERE.has(k) ? 'err' : 'warn', now, before);
  }
  const level = problems.some((p) => p.level === 'err') ? 'err' : problems.length ? 'warn' : d.health === null && d.partial && d.tempC === null ? 'unknown' : 'ok';
  return { level, problems };
}

/** Values kept per sample (history for trends and growth). */
function sample(d, t) {
  const s = { t, tempC: d.tempStale ? null : d.tempC, wearPct: d.wearPct, powerOnHours: d.powerOnHours };
  for (const k of COUNTERS) s[k] = d[k];
  return s;
}

/** Store a sample? Only when an hour has passed or a counter/wear changed – keeps the history small. */
function worthKeeping(last, s) {
  if (!last) return true;
  if (s.t - last.t >= 3600000) return true;
  return ['wearPct', ...COUNTERS].some((k) => s[k] !== last[k]);
}

/**
 * Should a notification go out for this problem? New problems, a worse level, or a counter that grew again since the
 * last alert. Temperature/wear alert again only after `again` ms (default 24 h) while they last.
 */
function shouldAlert(p, previous, now, again = 86400000) {
  if (!previous) return true;
  if (previous.level === 'warn' && p.level === 'err') return true;
  if (p.code.startsWith('grow:')) return p.value > previous.value;
  return now - previous.t >= again;
}

/**
 * Rough remaining life of an SSD at the same use: from the wear trend of the history (at least 30 days and 1 % more),
 * otherwise from the average so far (power-on hours per percent). The share of the day the drive runs comes from the
 * history (power-on hours vs. calendar time) or – unknown – is taken as 24/7, which errs on the short side.
 *   → { years, basis: 'trend' | 'average' } · { years: 0 } when worn out · null when it is too early to say
 */
function estimateLife(d, history = []) {
  const wear = d ? d.wearPct : null;
  if (wear === null || wear === undefined || d.media === 'hdd') return null;
  if (wear >= 100) return { years: 0, basis: 'average' };
  const pts = (history || []).filter((h) => h && Number.isFinite(h.t) && Number.isFinite(h.wearPct));
  const YEAR = 365.25 * 86400000;
  if (pts.length >= 2) {
    const a = pts[0]; const b = pts[pts.length - 1];
    if (b.t - a.t >= 30 * 86400000 && b.wearPct - a.wearPct >= 1) {
      const perMs = (b.wearPct - a.wearPct) / (b.t - a.t);
      return { years: Math.round(((100 - wear) / perMs / YEAR) * 10) / 10, basis: 'trend' };
    }
  }
  const poh = d.powerOnHours;
  if (!poh || poh < 500 || wear < 1) return null;
  let duty = 1;
  const ph = (history || []).filter((h) => h && Number.isFinite(h.t) && Number.isFinite(h.powerOnHours));
  if (ph.length >= 2) {
    const a = ph[0]; const b = ph[ph.length - 1];
    const wall = (b.t - a.t) / 3600000;
    if (wall >= 72 && b.powerOnHours > a.powerOnHours) duty = Math.min(1, (b.powerOnHours - a.powerOnHours) / wall);
  }
  const hoursLeft = ((100 - wear) * poh) / wear;
  return { years: Math.round((hoursLeft / Math.max(duty, 0.05) / 8766) * 10) / 10, basis: 'average' };
}

module.exports = {
  parseWindows, parseSmartctl, parseSys, parseUdisks, parseAdminResult, mergeDrive, matchDrives, assess, tempLevel, sample, worthKeeping, shouldAlert,
  estimateLife, extractJson, COUNTERS, DEFAULT_LIMITS, MARK_START, MARK_END, WIN_FIELDS, NVME_FIELDS,
};
