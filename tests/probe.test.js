'use strict';
// Drive health – reading with a simulated system: which commands run (only reading ones) and how the results combine.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../server/probe');

/** Simulated machine: commands → answers, files → contents. Records every command. */
function fakeIo({ platform, cmds = {}, files = {} }) {
  const calls = [];
  const dirs = {};
  for (const f of Object.keys(files)) { const parts = f.split('/'); for (let i = 2; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); (dirs[d] = dirs[d] || new Set()).add(parts[i]); } }
  return {
    platform,
    calls,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      const key = Object.keys(cmds).find((k) => [cmd, ...args].join(' ').startsWith(k));
      if (!key) return { code: 127, stdout: '', stderr: 'not found', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) };
      return { code: 0, stdout: typeof cmds[key] === 'string' ? cmds[key] : JSON.stringify(cmds[key]), stderr: '' };
    },
    readdir: async (p) => { if (!dirs[p]) throw new Error('ENOENT'); return [...dirs[p]]; },
    readFile: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
  };
}

const SYS = {
  '/sys/block/sda/size': '7814037168', '/sys/block/sda/queue/rotational': '1', '/sys/block/sda/removable': '0', '/sys/block/sda/device/model': 'ST4000DM004',
  '/sys/block/nvme0n1/size': '1953525168', '/sys/block/nvme0n1/queue/rotational': '0', '/sys/block/nvme0n1/removable': '0',
  '/sys/block/nvme0n1/device/model': 'WD Blue SN570 1TB', '/sys/block/nvme0n1/device/serial': '22123A456789',
  '/sys/block/nvme0n1/device/hwmon1/temp1_input': '46850',
  '/sys/block/loop0/size': '128',
};

test('Windows: nur PowerShell mit Lese-Befehlen, kodiert statt .ps1-Datei', async () => {
  const io = fakeIo({ platform: 'win32', cmds: { 'powershell.exe': '[{"DeviceId":"0","FriendlyName":"Disk","SerialNumber":"X1","MediaType":"SSD","BusType":"NVMe","Size":1,"HealthStatus":"Healthy","Counters":null}]' } });
  const r = await P.probe(io);
  assert.strictEqual(r.drives.length, 1);
  assert.deepStrictEqual(r.notes, ['needs-admin']);
  assert.match(io.calls[0], /-EncodedCommand /);
  const script = Buffer.from(P.psArgs()[P.psArgs().length - 1], 'base64').toString('utf16le');
  assert.match(script, /Get-PhysicalDisk/);
  assert.match(script, /Get-StorageReliabilityCounter/);
  // nichts, was ein Laufwerk verändert
  assert.doesNotMatch(script, /\b(Set-|Remove-|Clear-|Format-|Initialize-|Repair-|Optimize-|Reset-)/);
});

test('Windows: keine Laufwerke → Hinweis statt Absturz', async () => {
  const r = await P.probe(fakeIo({ platform: 'win32', cmds: { 'powershell.exe': '' } }));
  assert.deepStrictEqual([r.drives.length, r.notes[0]], [0, 'no-drives']);
});

test('Linux ohne smartctl: Laufwerke aus /sys mit Temperatur, Hinweis zum Nachinstallieren', async () => {
  const r = await P.probe(fakeIo({ platform: 'linux', files: SYS }));
  assert.strictEqual(r.source, 'sys');
  assert.deepStrictEqual(r.notes, ['install-smartctl']);
  assert.deepStrictEqual(r.drives.map((d) => [d.name, d.media, d.tempC]).sort(), [['ST4000DM004', 'hdd', null], ['WD Blue SN570 1TB', 'nvme', 47]]);
});

test('Linux mit smartctl: gelesene Laufwerke von smartctl, ohne Rechte geöffnete aus /sys – keins doppelt', async () => {
  const io = fakeIo({
    platform: 'linux', files: SYS,
    cmds: {
      'smartctl --scan -j': { devices: [{ name: '/dev/sda', type: 'sat' }, { name: '/dev/nvme0', type: 'nvme' }, { name: '/dev/sdz; rm -rf /', type: 'sat' }] },
      'smartctl -j -d sat -a /dev/sda': { smartctl: { exit_status: 2 }, device: { name: '/dev/sda' } },
      'smartctl -j -d nvme -a /dev/nvme0': { smartctl: { exit_status: 0 }, device: { name: '/dev/nvme0', type: 'nvme' }, model_name: 'WD Blue SN570 1TB', serial_number: '22123A456789', nvme_smart_health_information_log: { percentage_used: 4, temperature: 47, media_errors: 0 } },
    },
  });
  const r = await P.probe(io);
  assert.strictEqual(r.source, 'smartctl');
  assert.deepStrictEqual(r.notes, ['smartctl-rights']);
  assert.deepStrictEqual(r.drives.map((d) => [d.name, d.source]), [['WD Blue SN570 1TB', 'smartctl'], ['ST4000DM004', 'sys']]);
  // Gerätenamen mit fremden Zeichen werden nie als Befehl weitergegeben
  assert.ok(io.calls.every((c) => !c.includes('rm -rf')));
  assert.ok(io.calls.every((c) => /^smartctl (--scan -j|-j (-d \w+ )?-a \/dev\/\w+)$/.test(c)), io.calls.join('\n'));
});

test('anderes System ohne smartctl: „nicht unterstützt“', async () => {
  const r = await P.probe(fakeIo({ platform: 'darwin' }));
  assert.deepStrictEqual([r.drives.length, r.notes[0]], [0, 'unsupported']);
});
