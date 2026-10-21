'use strict';
/*
 * Drive health – pure logic without Hostwerk (tested with recorded outputs in tests/).
 *
 *   parseWindows(text)          → drives from the PowerShell probe (Get-PhysicalDisk + Get-StorageReliabilityCounter)
 *   parseSmartctl(json, device) → one drive from `smartctl -j -a <device>` (ATA/SATA and NVMe)
 *   parseSys(entries)           → drives from /sys/block (Linux without smartctl or without the rights for it)
 *   assess(drive, prev, limits) → { level, problems } – current values and growth since the previous sample
 *
 * Every drive has the same shape; values the source does not know stay null (never 0 – "unknown" is not "no errors").
 */

/** Counters that only ever grow on a healthy drive if something is wrong – growth is reported. */
const COUNTERS = ['readErrors', 'writeErrors', 'reallocated', 'pending', 'uncorrectable', 'mediaErrors', 'crcErrors', 'ioErrors'];
/** Growth of these means the surface or the flash is failing → error; the others are a warning (cable, controller …). */
const SEVERE = new Set(['reallocated', 'pending', 'uncorrectable', 'mediaErrors']);

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const clampPct = (v) => (v === null ? null : Math.max(0, Math.min(100, Math.round(v))));

function blank(extra) {
  return {
    id: '', name: '', serial: null, media: 'unknown', bus: null, sizeBytes: null, health: null, status: null,
    tempC: null, tempMaxC: null, wearPct: null, powerOnHours: null, spareLow: false, criticalWarning: null,
    readErrors: null, writeErrors: null, reallocated: null, pending: null, uncorrectable: null, mediaErrors: null, crcErrors: null, ioErrors: null,
    source: null, partial: false, note: null, ...extra,
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

/**
 * Output of the PowerShell probe: [{ DeviceId, FriendlyName, SerialNumber, MediaType, BusType, Size, HealthStatus,
 * OperationalStatus, Counters: { Temperature, TemperatureMax, Wear, PowerOnHours, ReadErrorsUncorrected, … } | null, CounterError }]
 */
function parseWindows(text) {
  let list = extractJson(text);
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
      // Wear 0 is also what drives report that do not know it – only trust it together with other counters
      wearPct: c && num(c.Wear) !== null ? clampPct(num(c.Wear)) : null,
      powerOnHours: c ? num(c.PowerOnHours) : null,
      readErrors: c ? num(c.ReadErrorsUncorrected) : null,
      writeErrors: c ? num(c.WriteErrorsUncorrected) : null,
      source: 'windows',
      partial: !c,
      note: c ? null : 'counters-unavailable',
    });
  });
}

/* ---------------- smartctl (Linux, also works on Windows/macOS when installed) ---------------- */
const attr = (table, id) => (Array.isArray(table) ? table.find((a) => a && a.id === id) : null) || null;
const rawOf = (a) => (a && a.raw ? num(a.raw.value) : null);

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
    media: nvme ? 'nvme' : rot === 0 ? 'ssd' : rot > 0 ? 'hdd' : 'unknown',
    bus: nvme ? 'NVMe' : (j.device && j.device.protocol) || null,
    sizeBytes: j.user_capacity ? num(j.user_capacity.bytes) : j.nvme_total_capacity ? num(j.nvme_total_capacity) : null,
    health: j.smart_status && typeof j.smart_status.passed === 'boolean' ? (j.smart_status.passed ? 'healthy' : 'unhealthy') : null,
    tempC: j.temperature ? num(j.temperature.current) : null,
    powerOnHours: j.power_on_time ? num(j.power_on_time.hours) : null,
    source: 'smartctl',
    device: device || (j.device && j.device.name) || null,
  });
  if (nvme) {
    const l = j.nvme_smart_health_information_log || {};
    if (d.tempC === null) d.tempC = num(l.temperature);
    if (d.powerOnHours === null) d.powerOnHours = num(l.power_on_hours);
    d.wearPct = clampPct(num(l.percentage_used));
    d.mediaErrors = num(l.media_errors);
    d.criticalWarning = num(l.critical_warning);
    const spare = num(l.available_spare); const thr = num(l.available_spare_threshold);
    d.spareLow = spare !== null && thr !== null && thr > 0 && spare < thr;
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
    // SSD wear: normalised "life left" attributes count down from 100
    const life = [231, 233, 177, 202, 169].map((id) => attr(t, id)).find((a) => a && num(a.value) !== null);
    if (life && d.media !== 'hdd') d.wearPct = clampPct(100 - num(life.value));
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

/* ---------------- Assessment ---------------- */
const DEFAULT_LIMITS = { tempWarn: 60, tempCrit: 70, wearWarn: 80, wearCrit: 95 };

/**
 * Problems of one drive: health status, temperature, wear, spare, and counters that grew since `prev` (the last stored
 * sample of the same drive). Each problem: { code, level: 'warn'|'err', value, before? }.
 */
function assess(d, prev, limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => Number.isFinite(v))) };
  const problems = [];
  const add = (code, level, value, before) => problems.push({ code, level, value: value === undefined ? null : value, ...(before !== undefined ? { before } : {}) });
  if (d.health === 'unhealthy') add('health', 'err', d.health);
  else if (d.health === 'warning') add('health', 'warn', d.health);
  if (d.criticalWarning) add('critical', 'err', d.criticalWarning);
  if (d.spareLow) add('spare', 'err');
  if (d.tempC !== null) {
    // Limit of the drive itself (NVMe report it) wins over the general one, but never above it + 15 °C
    const crit = d.tempMaxC ? Math.min(d.tempMaxC, L.tempCrit + 15) : L.tempCrit;
    if (d.tempC >= crit) add('temp', 'err', d.tempC);
    else if (d.tempC >= Math.min(L.tempWarn, crit - 1)) add('temp', 'warn', d.tempC);
  }
  if (d.wearPct !== null) {
    if (d.wearPct >= L.wearCrit) add('wear', 'err', d.wearPct);
    else if (d.wearPct >= L.wearWarn) add('wear', 'warn', d.wearPct);
  }
  if (d.pending) add('pending', 'warn', d.pending);
  for (const k of COUNTERS) {
    const now = d[k]; const before = prev ? prev[k] : null;
    if (now === null || before === null || before === undefined || now <= before) continue;
    add(`grow:${k}`, SEVERE.has(k) ? 'err' : 'warn', now, before);
  }
  const level = problems.some((p) => p.level === 'err') ? 'err' : problems.length ? 'warn' : d.health === null && d.partial && d.tempC === null ? 'unknown' : 'ok';
  return { level, problems };
}

/** Values kept per sample (history for trends and growth). */
function sample(d, t) {
  const s = { t, tempC: d.tempC, wearPct: d.wearPct, powerOnHours: d.powerOnHours };
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

module.exports = { parseWindows, parseSmartctl, parseSys, assess, sample, worthKeeping, shouldAlert, extractJson, COUNTERS, DEFAULT_LIMITS };
