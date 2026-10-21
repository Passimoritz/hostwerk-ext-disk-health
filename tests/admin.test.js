'use strict';
// Drive health – the administrator check: scripts (only reading, one prompt, task cleans up after itself) and the
// results for NVMe, SATA SSD and a hard disk in a USB case, recorded shapes of PowerShell and smartctl (shortened).
const test = require('node:test');
const assert = require('node:assert');
const H = require('../server/health');
const A = require('../server/admin');
const { describe } = require('../server/texts');

/* ---------------- Recorded shapes ---------------- */
const NVME = {
  smartctl: { exit_status: 0 }, device: { name: '/dev/nvme0', type: 'nvme', protocol: 'NVMe' },
  model_name: 'Predator SSD GM7 2TB', serial_number: 'PBAC12345678', firmware_version: 'SN11923', nvme_total_capacity: 2048408248320,
  smart_status: { passed: true }, temperature: { current: 44 }, power_cycle_count: 812, power_on_time: { hours: 3120 },
  nvme_smart_health_information_log: { critical_warning: 0, temperature: 44, available_spare: 100, available_spare_threshold: 5, percentage_used: 2,
    data_units_read: 34567890, data_units_written: 23456789, host_reads: 1, host_writes: 2, controller_busy_time: 3, power_cycles: 812, power_on_hours: 3120,
    unsafe_shutdowns: 41, media_errors: 0, num_err_log_entries: 7, warning_temp_time: 0, critical_comp_time: 0 },
};
const SATA = {
  smartctl: { exit_status: 0 }, device: { name: '/dev/sda', type: 'ata', protocol: 'ATA' }, model_name: 'CT500MX500SSD1', serial_number: '1934E2A1B2C3',
  user_capacity: { bytes: 500107862016 }, logical_block_size: 512, rotation_rate: 0, smart_status: { passed: true }, power_on_time: { hours: 9000 },
  ata_smart_attributes: { table: [
    { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, when_failed: '', raw: { value: 0, string: '0' } },
    { id: 9, name: 'Power_On_Hours', value: 100, worst: 100, thresh: 0, raw: { value: 9000, string: '9000' } },
    { id: 12, name: 'Power_Cycle_Count', value: 100, worst: 100, thresh: 0, raw: { value: 1500, string: '1500' } },
    { id: 194, name: 'Temperature_Celsius', value: 65, worst: 47, thresh: 0, raw: { value: 158914969635, string: '35 (Min/Max 18/53)' } },
    { id: 202, name: 'Percent_Lifetime_Remain', value: 92, worst: 92, thresh: 1, raw: { value: 8, string: '8' } },
    { id: 241, name: 'Total_LBAs_Written', value: 100, worst: 100, thresh: 0, raw: { value: 40000000000, string: '40000000000' } },
  ] },
};
const HDD_USB = {
  smartctl: { exit_status: 0 }, device: { name: '/dev/sdb', info_name: '/dev/sdb [USB JMicron]', type: 'sat', protocol: 'ATA' },
  model_name: 'WDC WD20EZRZ-00Z5HB0', serial_number: 'WD-WCC4M0ABCDEF', user_capacity: { bytes: 2000398934016 }, rotation_rate: 5400,
  smart_status: { passed: true }, power_on_time: { hours: 41000 },
  ata_smart_attributes: { table: [
    { id: 5, name: 'Reallocated_Sector_Ct', value: 120, worst: 120, thresh: 140, when_failed: 'FAILING_NOW', raw: { value: 830, string: '830' } },
    { id: 197, name: 'Current_Pending_Sector', value: 200, worst: 200, thresh: 0, when_failed: '-', raw: { value: 2, string: '2' } },
  ] },
};
const disks = [
  { DeviceId: '0', FriendlyName: 'Predator SSD GM7 2TB', SerialNumber: '0000_0000_0000_0000_50C6_8E52_7150_2160.', MediaType: 'SSD', BusType: 'NVMe', Size: 2048408248320, HealthStatus: 'Healthy', OperationalStatus: 'OK',
    Counters: { Temperature: 44, TemperatureMax: 84, Wear: 2, PowerOnHours: 3120, ReadErrorsUncorrected: 0, WriteErrorsUncorrected: 0 } },
  { DeviceId: '1', FriendlyName: 'CT500MX500SSD1', SerialNumber: '1934E2A1B2C3', MediaType: 'SSD', BusType: 'SATA', Size: 500107862016, HealthStatus: 'Healthy', OperationalStatus: 'OK',
    Counters: { Temperature: 0, TemperatureMax: 0, Wear: 0, PowerOnHours: 9000, ReadErrorsUncorrected: 0, WriteErrorsUncorrected: 0 } },
  { DeviceId: '2', FriendlyName: 'WD Elements 25A2', SerialNumber: 'WD-WCC4M0ABCDEF', MediaType: 'HDD', BusType: 'USB', Size: 2000398934016, HealthStatus: 'Healthy', OperationalStatus: 'OK', Counters: null },
];
const wrap = (o) => `Start-Process noise\r\n${H.MARK_START}${JSON.stringify(o)}${H.MARK_END}\r\n{stderr: "}"}`;
const ADMIN = wrap({ v: 1, at: 1792600000000, admin: true, disks,
  smart: [{ device: '/dev/nvme0', type: 'nvme', json: JSON.stringify(NVME) }, { device: '/dev/sda', type: 'ata', json: JSON.stringify(SATA) }, { device: '/dev/sdb', type: 'sat', json: JSON.stringify(HDD_USB) }] });

/* ---------------- Results ---------------- */
test('Admin-Ergebnis: Windows + smartctl je Laufwerk zusammengeführt (NVMe, SATA-SSD, HDD im USB-Gehäuse)', () => {
  const r = H.parseAdminResult(ADMIN);
  assert.strictEqual(r.at, 1792600000000);
  assert.strictEqual(r.admin, true);
  assert.strictEqual(r.smartctl, true);
  assert.strictEqual(r.drives.length, 3);
  const [nv, sata, hdd] = r.drives;
  // NVMe: Windows zeigt die EUI-64 – Treffer über Modell + Größe, die echte Seriennummer kommt von smartctl, die id bleibt
  assert.strictEqual(nv.id, '0000_0000_0000_0000_50C6_8E52_7150_2160');
  assert.strictEqual(nv.serial, 'PBAC12345678');
  assert.deepStrictEqual([nv.tempC, nv.tempMaxC, nv.wearPct, nv.powerOnHours, nv.unsafeShutdowns, nv.spareLeftPct, nv.firmware], [44, 84, 2, 3120, 41, 100, 'SN11923']);
  assert.strictEqual(nv.dataWrittenBytes, 23456789 * 512000);
  assert.ok(nv.attributes.some((a) => a.key === 'nvme:percentage_used' && a.value === 2));
  assert.strictEqual(nv.partial, false);
  assert.strictEqual(nv.smartAt, 1792600000000);
  // SATA-SSD: Windows meldet Abnutzung 0 (versteht das Laufwerk nicht) – smartctl gewinnt: 100 - 92 = 8 %
  assert.deepStrictEqual([sata.media, sata.wearPct, sata.tempC, sata.powerCycles], ['ssd', 8, 35, 1500]);
  assert.strictEqual(sata.dataWrittenBytes, 40000000000 * 512);
  assert.strictEqual(sata.attributes.find((a) => a.id === 194).value, '35 (Min/Max 18/53)');
  // HDD im USB-Gehäuse: nur smartctl kommt durch; Attribut unter der Herstellergrenze → Fehler
  assert.deepStrictEqual([hdd.media, hdd.bus, hdd.reallocated, hdd.pending, hdd.partial], ['hdd', 'USB', 830, 2, false]);
  const a = H.assess(hdd, null);
  assert.strictEqual(a.level, 'err');
  assert.deepStrictEqual(a.problems.map((p) => p.code), ['pending', 'attr']);
  const t = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : s);
  assert.match(describe(a.problems[1], t), /Reallocated Sector Ct/);
});

test('Admin-Ergebnis: nur Windows (ohne smartctl), fehlende Werte bleiben null', () => {
  const r = H.parseAdminResult(wrap({ v: 1, at: 5, admin: true, disks: [disks[1], disks[2]], smart: [] }));
  assert.strictEqual(r.smartctl, false);
  const [sata, hdd] = r.drives;
  assert.deepStrictEqual([sata.wearPct, sata.tempC, sata.dataWrittenBytes, sata.partial], [0, null, null, false]);
  assert.ok(sata.attributes.some((a) => a.key === 'win:PowerOnHours'));
  // Das USB-Gehäuse gibt Windows keine Zähler – ehrlich unbekannt, kein „0 Fehler“
  assert.deepStrictEqual([hdd.partial, hdd.readErrors, hdd.wearPct, hdd.attributes], [true, null, null, null]);
});

test('Admin-Ergebnis: abgebrochen, ohne Rechte, Müll', () => {
  assert.strictEqual(H.parseAdminResult(''), null);
  assert.strictEqual(H.parseAdminResult('Der Vorgang wurde durch den Benutzer abgebrochen.'), null);
  assert.strictEqual(H.parseAdminResult(`${H.MARK_START}{broken${H.MARK_END}`), null);
  assert.strictEqual(H.parseAdminResult(wrap({ v: 1, at: 1, admin: false, disks: [disks[0]], smart: [] })).admin, false);
});

test('Lebensdauer: Trend, Durchschnitt, zu früh, verschlissen, Festplatte', () => {
  const day = 86400000;
  // Durchschnitt: 2 % in 3120 h → 98 % noch 152 880 h, rund um die Uhr ≈ 17,4 Jahre
  assert.deepStrictEqual(H.estimateLife({ media: 'nvme', wearPct: 2, powerOnHours: 3120 }, []), { years: 17.4, basis: 'average' });
  // Läuft nur 8 von 24 Stunden (aus dem Verlauf) → dreimal so lange
  const hist = [{ t: 0, wearPct: 2, powerOnHours: 3000 }, { t: 9 * day, wearPct: 2, powerOnHours: 3072 }];
  assert.deepStrictEqual(H.estimateLife({ media: 'nvme', wearPct: 2, powerOnHours: 3120 }, hist), { years: 52.3, basis: 'average' });
  // Trend: 1 % in 60 Tagen, 90 % übrig → 5400 Tage
  const trend = [{ t: 0, wearPct: 9 }, { t: 60 * day, wearPct: 10 }];
  assert.deepStrictEqual(H.estimateLife({ media: 'ssd', wearPct: 10, powerOnHours: 9000 }, trend), { years: 14.8, basis: 'trend' });
  assert.strictEqual(H.estimateLife({ media: 'nvme', wearPct: 0, powerOnHours: 100 }, []), null);
  assert.deepStrictEqual(H.estimateLife({ media: 'nvme', wearPct: 100, powerOnHours: 1 }), { years: 0, basis: 'average' });
  assert.strictEqual(H.estimateLife({ media: 'hdd', wearPct: null, powerOnHours: 40000 }), null);
});

test('Temperatur-Ampel und alte Temperatur aus einer früheren Prüfung', () => {
  assert.strictEqual(H.tempLevel({ tempC: 45 }), 'ok');
  assert.strictEqual(H.tempLevel({ tempC: 61 }), 'warn');
  assert.strictEqual(H.tempLevel({ tempC: 70 }), 'err');
  assert.strictEqual(H.tempLevel({ tempC: null }), null);
  const d = { ...H.parseAdminResult(ADMIN).drives[0], tempC: 85 }; // eigene Grenze des Laufwerks: 84 °C
  assert.strictEqual(H.assess(d, null).level, 'err');
  // Gemessen vor Stunden: sagt nichts über jetzt – keine Warnung, nicht im Verlauf
  assert.strictEqual(H.assess({ ...d, tempStale: true }, null).level, 'ok');
  assert.strictEqual(H.sample({ ...d, tempStale: true }, 1).tempC, null);
});

test('Zusammenführen: frische Basis-Temperatur gilt, alte Admin-Temperatur füllt nur Lücken', () => {
  const base = { ...H.parseSys([{ name: 'nvme0n1', model: 'X', serial: 'S1', size: '100', rotational: '0', tempMilli: '40000' }])[0] };
  const extra = { ...H.parseSmartctl({ ...NVME, serial_number: 'S1' }), tempStale: true };
  const m = H.mergeDrive(base, extra);
  assert.deepStrictEqual([m.tempC, m.tempStale, m.wearPct, m.id], [44, false, 2, base.id]); // smartctl-Temperatur, aber nicht „alt“ markiert, weil die Basis eine hatte
  const noTemp = H.mergeDrive({ ...base, tempC: null }, extra);
  assert.deepStrictEqual([noTemp.tempC, noTemp.tempStale], [44, true]);
});

test('udisks ohne root: Temperatur, Betriebszeit, defekte Sektoren, NVMe-Warnung', () => {
  const v = (type, data) => ({ type, data });
  const j = { type: 'a{oa{sa{sv}}}', data: [{
    '/org/freedesktop/UDisks2/drives/ST4000': {
      'org.freedesktop.UDisks2.Drive': { Model: v('s', 'ST4000DM004'), Serial: v('s', 'ZFN0ABCD'), Size: v('t', 4000787030016), Rotational: v('b', true), ConnectionBus: v('s', '') },
      'org.freedesktop.UDisks2.Drive.Ata': { SmartSupported: v('b', true), SmartEnabled: v('b', true), SmartUpdated: v('t', 1792600000), SmartFailing: v('b', false), SmartPowerOnSeconds: v('t', 83196000), SmartTemperature: v('d', 311.15), SmartNumBadSectors: v('x', 8) },
    },
    '/org/freedesktop/UDisks2/drives/WD_SN570': {
      'org.freedesktop.UDisks2.Drive': { Model: v('s', 'WD Blue SN570 1TB'), Serial: v('s', '22123A456789'), Size: v('t', 1000204886016), Rotational: v('b', false) },
      'org.freedesktop.UDisks2.NVMe.Controller': { SmartUpdated: v('t', 1792600000), SmartCriticalWarning: v('as', ['temperature']), SmartPowerOnHours: v('t', 3100), SmartTemperature: v('q', 320) },
    },
    '/org/freedesktop/UDisks2/block_devices/sda': { 'org.freedesktop.UDisks2.Block': {} },
  }] };
  const [hdd, nv] = H.parseUdisks(j);
  assert.deepStrictEqual([hdd.name, hdd.media, hdd.tempC, hdd.powerOnHours, hdd.reallocated, hdd.health], ['ST4000DM004', 'hdd', 38, 23110, 8, 'healthy']);
  assert.deepStrictEqual([nv.media, nv.tempC, nv.powerOnHours, nv.health, nv.criticalWarning], ['nvme', 47, 3100, 'warning', 1]);
  assert.deepStrictEqual(H.parseUdisks(null), []);
  assert.deepStrictEqual(H.parseUdisks({ data: [] }), []);
});

/* ---------------- Scripts ---------------- */
const decode = (args) => Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
const SC = 'C:\\Program Files\\smartmontools\\bin\\smartctl.exe';
const DIR = 'C:\\ProgramData\\HostwerkDiskHealth';

test('Prüf-Skript: nur lesende Befehle, Markierungen, smartctl nur mit geprüften Gerätenamen', () => {
  const s = A.checkScript({ smartctl: SC });
  assert.match(s, /Get-PhysicalDisk/);
  assert.match(s, /Get-StorageReliabilityCounter/);
  assert.match(s, /--scan-open -j/);
  assert.match(s, /\$n -notmatch '\^\/dev\//);
  assert.ok(s.includes(H.MARK_START) && s.includes(H.MARK_END));
  assert.doesNotMatch(s, /\b(Set-|Remove-|Clear-|Format-|Initialize-|Repair-|Optimize-|Reset-|Register-|Unregister-)/);
  assert.doesNotMatch(s, /smartctl\S* .*(-s |--smart=|-t |--test|-X)/);
  // ohne smartctl: leerer Pfad, der Teil wird übersprungen
  assert.match(A.checkScript({}), /\$sc = ''/);
  assert.strictEqual(decode(A.psArgs(s)), s);
});

test('Windows-Aufgabe: SYSTEM, nur Lese-Skript, Ordner nur für Administratoren, räumt sich selbst auf', () => {
  const marker = 'C:\\Users\\Pat\\Hostwerk\\extensions\\disk-health\\manifest.json';
  const inst = A.installScript({ smartctl: SC, marker, dir: DIR });
  assert.match(inst, /Register-ScheduledTask -TaskName 'DiskHealth' -TaskPath '\\Hostwerk\\'/);
  assert.match(inst, /-UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest/);
  assert.match(inst, /RepetitionInterval \(New-TimeSpan -Minutes 60\)/);
  assert.match(inst, /\/inheritance:r \/grant:r '\*S-1-5-18:\(OI\)\(CI\)F' '\*S-1-5-32-544:\(OI\)\(CI\)F' '\*S-1-5-32-545:\(OI\)\(CI\)RX'/);
  assert.match(inst, /\/setowner '\*S-1-5-32-544'/);
  assert.ok(inst.includes(`-File "${DIR}\\probe.ps1"`));
  const task = A.taskScript({ smartctl: SC, marker, dir: DIR });
  // Erweiterung weg (zweimal geprüft) → Aufgabe und Ordner entfernen sich selbst
  assert.ok(task.indexOf(`Test-Path -LiteralPath '${marker}'`) < task.indexOf('Unregister-ScheduledTask'));
  assert.match(task, /Start-Sleep -Seconds 120/);
  assert.match(task, /rd \/s \/q/);
  assert.ok(task.includes(`${DIR}\\smart.json`));
  // das Lese-Skript selbst ändert nichts außer seiner Ergebnisdatei
  const reading = task.slice(task.indexOf('$out = @()'));
  assert.doesNotMatch(reading, /\b(Set-|Remove-|Clear-|Format-|Initialize-|Repair-|Register-|Unregister-)/);
  // Abschalten: Aufgabe + Ordner weg, der Ordner „Hostwerk“ der Aufgabenplanung nur, wenn leer
  const rem = A.removeScript({ dir: DIR });
  assert.match(rem, /Unregister-ScheduledTask -TaskName 'DiskHealth' -TaskPath '\\Hostwerk\\' -Confirm:\$false/);
  assert.match(rem, /GetTasks\(1\)\.Count -eq 0/);
  // Hochkommas in Pfaden werden verdoppelt (PowerShell)
  assert.match(A.taskScript({ marker: "C:\\Users\\O'Neil\\m.json", dir: DIR }), /O''Neil/);
});

test('Antwort der Einrichtung lesen', () => {
  assert.deepStrictEqual(A.parseOk(`x${H.MARK_START}{"ok":true}${H.MARK_END}`), { ok: true, error: null });
  assert.deepStrictEqual(A.parseOk(`${H.MARK_START}{"ok":false,"error":"Zugriff verweigert"}${H.MARK_END}`), { ok: false, error: 'Zugriff verweigert' });
  assert.deepStrictEqual(A.parseOk(''), { ok: false, error: null });
});

test('smartctl: nur aus „Programme“, Version ab 7.0', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' };
  assert.strictEqual(A.trustedSmartctl(SC, env), true);
  assert.strictEqual(A.trustedSmartctl('C:\\Users\\Pat\\scoop\\shims\\smartctl.exe', env), false);
  assert.strictEqual(A.trustedSmartctl('C:\\Program Files\\..\\Users\\smartctl.exe', env), false);
  assert.strictEqual(A.trustedSmartctl('smartctl.exe', env), false);
  assert.strictEqual(A.parseVersion('smartctl 7.4 2023-08-01 r5530 [x86_64-w64-mingw32-w10-b19045] (sf-7.4-1)'), '7.4');
  assert.strictEqual(A.parseVersion('nothing'), null);
  assert.deepStrictEqual(['6.6', '7.0', '7.5', '10.1', null].map(A.versionOk), [false, true, true, true, false]);
  assert.deepStrictEqual(A.smartctlCandidates(env), [SC, SC, 'C:\\Program Files (x86)\\smartmontools\\bin\\smartctl.exe']);
  assert.strictEqual(A.taskDir({ ProgramData: 'D:\\PD' }), 'D:\\PD\\HostwerkDiskHealth');
});

test('Linux: ein pkexec-Lauf, smartctl je Gerät, fremde Gerätenamen fliegen raus', () => {
  const steps = A.linuxSteps([{ name: '/dev/sda', type: 'sat' }, { name: '/dev/nvme0', type: 'nvme' }, { name: '/dev/sdz; rm -rf /', type: 'sat' }, { name: '/dev/sdc', type: 'sat;reboot' }]);
  assert.deepStrictEqual(steps, [
    { cmd: 'smartctl', args: ['-j', '-d', 'sat', '-a', '/dev/sda'] },
    { cmd: 'smartctl', args: ['-j', '-d', 'nvme', '-a', '/dev/nvme0'] },
    { cmd: 'smartctl', args: ['-j', '-a', '/dev/sdc'] },
  ]);
});

test('NVMe ohne Betriebsstunden von Windows (wie Predator GM7): bleibt null, Quelle „windows“, nur gemeldete Werte in der Tabelle', () => {
  const r = H.parseAdminResult(wrap({ v: 1, at: 9, admin: true, smart: [],
    disks: [{ ...disks[0], Counters: { Temperature: 51, TemperatureMax: 84, Wear: 0, PowerOnHours: null, ReadErrorsUncorrected: null, WriteErrorsUncorrected: null } }] }));
  const [d] = r.drives;
  assert.deepStrictEqual([d.tempC, d.wearPct, d.powerOnHours, d.source, d.partial], [51, 0, null, 'windows', false]);
  assert.deepStrictEqual(d.attributes.map((a) => a.key), ['win:Temperature', 'win:TemperatureMax', 'win:Wear']);
  assert.strictEqual(H.estimateLife(d, []), null); // ohne Betriebsstunden keine Schätzung – „Noch zu früh“
});
