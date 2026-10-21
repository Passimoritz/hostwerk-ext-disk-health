'use strict';
// Drive health – parsers and assessment with outputs recorded from real systems (shortened), no drive is touched.
const test = require('node:test');
const assert = require('node:assert');
const H = require('../server/health');
const { describe } = require('../server/texts');

/* ---------------- Windows ---------------- */
// Without admin rights: Get-StorageReliabilityCounter is denied, the drive list is still there (recorded on Windows 11)
const WIN_USER = '﻿[{"DeviceId":"0","FriendlyName":"Predator SSD GM7 2TB","SerialNumber":"0000_0000_0000_0000_50C6_8E52_7150_2160.","MediaType":"SSD","BusType":"NVMe","Size":2048408248320,"HealthStatus":"Healthy","OperationalStatus":"OK","Counters":null,"CounterError":"Access denied"}]';
// As administrator, two drives, one of them an old HDD with errors
const WIN_ADMIN = `WARNING: something on stderr that ended up in stdout
[{"DeviceId":"0","FriendlyName":"Samsung SSD 980 PRO 1TB","SerialNumber":"S5GXNX0R123456","MediaType":"SSD","BusType":"NVMe","Size":1000204886016,"HealthStatus":"Healthy","OperationalStatus":"OK",
  "Counters":{"Temperature":41,"TemperatureMax":82,"Wear":3,"PowerOnHours":5120,"ReadErrorsUncorrected":0,"ReadErrorsTotal":0,"WriteErrorsUncorrected":0,"WriteErrorsTotal":0},"CounterError":null},
 {"DeviceId":"1","FriendlyName":"WDC WD20EZRZ-00Z5HB0","SerialNumber":"WD-WCC4M0ABCDEF","MediaType":"HDD","BusType":"SATA","Size":2000398934016,"HealthStatus":"Warning","OperationalStatus":"Predictive Failure",
  "Counters":{"Temperature":0,"TemperatureMax":0,"Wear":0,"PowerOnHours":41000,"ReadErrorsUncorrected":12,"WriteErrorsUncorrected":0},"CounterError":null}]`;
// A single disk is no array in ConvertTo-Json without -InputObject @(…); older PowerShell sends enums as numbers
const WIN_NUMERIC = '{"DeviceId":2,"FriendlyName":"USB Stick","SerialNumber":"","MediaType":0,"BusType":7,"Size":31000000000,"HealthStatus":2,"OperationalStatus":"","Counters":null}';

test('Windows ohne Adminrechte: Laufwerk mit Zustand, Zähler fehlen (null, nicht 0)', () => {
  const [d] = H.parseWindows(WIN_USER);
  assert.strictEqual(d.name, 'Predator SSD GM7 2TB');
  assert.strictEqual(d.serial, '0000_0000_0000_0000_50C6_8E52_7150_2160'); // Punkt am Ende weg
  assert.strictEqual(d.media, 'nvme');
  assert.strictEqual(d.health, 'healthy');
  assert.strictEqual(d.partial, true);
  assert.strictEqual(d.note, 'counters-unavailable');
  assert.strictEqual(d.tempC, null);
  assert.strictEqual(d.readErrors, null);
  assert.strictEqual(H.assess(d, null).level, 'ok');
});

test('Windows als Admin: Temperatur, Abnutzung, Fehler; 0 °C heißt „unbekannt“', () => {
  const [ssd, hdd] = H.parseWindows(WIN_ADMIN);
  assert.deepStrictEqual([ssd.tempC, ssd.tempMaxC, ssd.wearPct, ssd.powerOnHours, ssd.readErrors], [41, 82, 3, 5120, 0]);
  assert.strictEqual(ssd.partial, false);
  assert.strictEqual(hdd.media, 'hdd');
  assert.strictEqual(hdd.bus, 'SATA');
  assert.strictEqual(hdd.tempC, null);
  assert.strictEqual(hdd.readErrors, 12);
  assert.strictEqual(hdd.status, 'Predictive Failure');
  const a = H.assess(hdd, null);
  assert.strictEqual(a.level, 'warn');
  assert.deepStrictEqual(a.problems.map((p) => p.code), ['health']);
});

test('Windows: Zahlen statt Text, einzelnes Objekt, Müll und leere Ausgabe', () => {
  const [d] = H.parseWindows(WIN_NUMERIC);
  assert.deepStrictEqual([d.media, d.bus, d.health, d.id], ['unknown', 'USB', 'unhealthy', 'win-2']);
  assert.strictEqual(H.assess(d, null).level, 'err');
  assert.deepStrictEqual(H.parseWindows(''), []);
  assert.deepStrictEqual(H.parseWindows('Get-PhysicalDisk : not recognized'), []);
  assert.deepStrictEqual(H.parseWindows('[{"broken": '), []);
});

/* ---------------- smartctl ---------------- */
const SMART_HDD = {
  smartctl: { exit_status: 0 }, device: { name: '/dev/sda', type: 'sat', protocol: 'ATA' },
  model_name: 'ST4000DM004-2CV104', serial_number: 'ZFN0ABCD', user_capacity: { bytes: 4000787030016 }, rotation_rate: 5425,
  smart_status: { passed: true }, temperature: { current: 38 }, power_on_time: { hours: 23110 },
  ata_smart_attributes: { table: [
    { id: 5, name: 'Reallocated_Sector_Ct', value: 100, raw: { value: 8 } },
    { id: 187, name: 'Reported_Uncorrect', value: 100, raw: { value: 0 } },
    { id: 194, name: 'Temperature_Celsius', value: 38, raw: { value: 158914969638 } },
    { id: 197, name: 'Current_Pending_Sector', value: 100, raw: { value: 0 } },
    { id: 198, name: 'Offline_Uncorrectable', value: 100, raw: { value: 0 } },
    { id: 199, name: 'UDMA_CRC_Error_Count', value: 200, raw: { value: 0 } },
  ] },
};
const SMART_SATA_SSD = {
  smartctl: { exit_status: 0 }, device: { name: '/dev/sdb', protocol: 'ATA' }, model_name: 'CT500MX500SSD1', serial_number: '1934E2A1B2C3',
  rotation_rate: 0, smart_status: { passed: true }, power_on_time: { hours: 9000 },
  ata_smart_attributes: { table: [{ id: 5, value: 100, raw: { value: 0 } }, { id: 194, value: 65, raw: { value: 35 } }, { id: 202, value: 100, raw: { value: 0 } }, { id: 231, value: 12, raw: { value: 12 } }] },
};
const SMART_NVME = {
  smartctl: { exit_status: 0 }, device: { name: '/dev/nvme0', type: 'nvme', protocol: 'NVMe' }, model_name: 'WD Blue SN570 1TB', serial_number: '22123A456789',
  nvme_total_capacity: 1000204886016, smart_status: { passed: true }, temperature: { current: 47 },
  nvme_smart_health_information_log: { critical_warning: 0, temperature: 47, available_spare: 100, available_spare_threshold: 10, percentage_used: 4, power_on_hours: 3100, media_errors: 0, num_err_log_entries: 12 },
};
const SMART_DENIED = { smartctl: { exit_status: 2, messages: [{ string: 'Smartctl open device: /dev/sda failed: Permission denied', severity: 'error' }] }, device: { name: '/dev/sda' } };

test('smartctl HDD: Sektoren, Temperatur, Betriebsstunden', () => {
  const d = H.parseSmartctl(SMART_HDD, '/dev/sda');
  assert.deepStrictEqual([d.media, d.tempC, d.powerOnHours, d.reallocated, d.pending, d.crcErrors, d.wearPct, d.health], ['hdd', 38, 23110, 8, 0, 0, null, 'healthy']);
  assert.strictEqual(d.id, 'ZFN0ABCD');
  assert.strictEqual(H.assess(d, null).level, 'ok'); // 8 alte Sektoren allein sind kein Alarm – erst wenn sie wachsen
});

test('smartctl SATA-SSD: Abnutzung aus „Lebensdauer übrig“, Temperatur aus Attribut 194', () => {
  const d = H.parseSmartctl(SMART_SATA_SSD, '/dev/sdb');
  assert.deepStrictEqual([d.media, d.wearPct, d.tempC], ['ssd', 88, 35]);
  assert.strictEqual(H.assess(d, null, { wearWarn: 80 }).problems[0].code, 'wear');
});

test('smartctl NVMe: Abnutzung, Medienfehler, Ersatzbereich', () => {
  const d = H.parseSmartctl(SMART_NVME, '/dev/nvme0');
  assert.deepStrictEqual([d.media, d.bus, d.wearPct, d.mediaErrors, d.tempC, d.powerOnHours, d.spareLow], ['nvme', 'NVMe', 4, 0, 47, 3100, false]);
  const low = H.parseSmartctl({ ...SMART_NVME, nvme_smart_health_information_log: { ...SMART_NVME.nvme_smart_health_information_log, available_spare: 5, critical_warning: 1 } });
  assert.deepStrictEqual(H.assess(low, null).problems.map((p) => p.code), ['critical', 'spare']);
});

test('smartctl ohne Rechte → null (Laufwerk kommt dann aus /sys)', () => {
  assert.strictEqual(H.parseSmartctl(SMART_DENIED, '/dev/sda'), null);
  assert.strictEqual(H.parseSmartctl(null), null);
});

/* ---------------- /sys ---------------- */
test('/sys: Modell, Größe, SSD/HDD, Temperatur, I/O-Fehler; Schleifen und RAM-Disks weg', () => {
  const list = H.parseSys([
    { name: 'nvme0n1', model: 'WD Blue SN570 1TB ', serial: '22123A456789', size: '1953525168', rotational: '0', removable: '0', tempMilli: '46850' },
    { name: 'sda', model: 'ST4000DM004', size: '7814037168', rotational: '1', removable: '0', ioerr: '0x3' },
    { name: 'loop0', size: '100' }, { name: 'zram0', size: '100' }, { name: 'sr0', size: '0' },
  ]);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual([list[0].media, list[0].tempC, list[0].sizeBytes, list[0].name], ['nvme', 47, 1953525168 * 512, 'WD Blue SN570 1TB']);
  assert.deepStrictEqual([list[1].media, list[1].ioErrors, list[1].id, list[1].note], ['hdd', 3, 'sys-sda', 'no-smart']);
});

/* ---------------- Bewertung ---------------- */
test('Temperatur: Warnung ab Grenze, Fehler ab kritisch, eigene Grenze des Laufwerks zählt', () => {
  const d = (tempC, tempMaxC = null) => ({ ...H.parseSys([{ name: 'sda', size: '1', rotational: '1' }])[0], tempC, tempMaxC });
  assert.strictEqual(H.assess(d(45), null).level, 'ok');
  assert.strictEqual(H.assess(d(62), null).level, 'warn');
  assert.strictEqual(H.assess(d(71), null).level, 'err');
  assert.strictEqual(H.assess(d(62), null, { tempWarn: 65, tempCrit: 75 }).level, 'ok');
  assert.strictEqual(H.assess(d(72, 70), null).level, 'err'); // Laufwerk sagt: ab 70 °C kritisch
});

test('wachsende Fehler: Sektoren = Fehler, Kabel/Lesefehler = Warnung, gleichbleibend = nichts', () => {
  const now = H.parseSmartctl(SMART_HDD, '/dev/sda');
  const prev = H.sample({ ...now, reallocated: 2, crcErrors: 0 }, 1);
  const a = H.assess({ ...now, crcErrors: 4 }, prev);
  assert.deepStrictEqual(a.problems.map((p) => [p.code, p.level, p.before, p.value]), [['grow:reallocated', 'err', 2, 8], ['grow:crcErrors', 'warn', 0, 4]]);
  assert.strictEqual(a.level, 'err');
  assert.strictEqual(H.assess(now, H.sample(now, 1)).problems.length, 0);
  // Unbekannt vorher (null) ist kein Wachstum
  assert.strictEqual(H.assess(now, { ...H.sample(now, 1), reallocated: null }).problems.length, 0);
});

test('Verlauf: nur stündlich oder bei Änderung speichern', () => {
  const d = H.parseSmartctl(SMART_NVME);
  const s1 = H.sample(d, 0);
  assert.strictEqual(H.worthKeeping(null, s1), true);
  assert.strictEqual(H.worthKeeping(s1, H.sample({ ...d, tempC: 50 }, 600000)), false);
  assert.strictEqual(H.worthKeeping(s1, H.sample({ ...d, mediaErrors: 1 }, 600000)), true);
  assert.strictEqual(H.worthKeeping(s1, H.sample(d, 3600000)), true);
});

test('Benachrichtigen: neu, schlimmer, weiter gewachsen – sonst erst nach einem Tag wieder', () => {
  const day = 86400000;
  assert.strictEqual(H.shouldAlert({ code: 'temp', level: 'warn', value: 62 }, undefined, 0), true);
  assert.strictEqual(H.shouldAlert({ code: 'temp', level: 'warn', value: 63 }, { t: 0, level: 'warn', value: 62 }, 1000), false);
  assert.strictEqual(H.shouldAlert({ code: 'temp', level: 'err', value: 71 }, { t: 0, level: 'warn', value: 62 }, 1000), true);
  assert.strictEqual(H.shouldAlert({ code: 'temp', level: 'warn', value: 62 }, { t: 0, level: 'warn', value: 62 }, day), true);
  assert.strictEqual(H.shouldAlert({ code: 'grow:reallocated', level: 'err', value: 8 }, { t: 0, level: 'err', value: 8 }, 10 * day), false);
  assert.strictEqual(H.shouldAlert({ code: 'grow:reallocated', level: 'err', value: 9 }, { t: 0, level: 'err', value: 8 }, 1000), true);
});

test('Texte für jede Art von Problem', () => {
  const t = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : s);
  assert.strictEqual(describe({ code: 'temp', level: 'err', value: 71 }, t), '71 °C – much too hot.');
  assert.strictEqual(describe({ code: 'grow:reallocated', level: 'err', value: 8, before: 2 }, t), 'Reallocated sectors rose from 2 to 8.');
  for (const code of ['health', 'critical', 'spare', 'wear', 'pending', 'grow:ioErrors']) assert.ok(describe({ code, level: 'warn', value: 1, before: 0 }, t).length > 5, code);
});
