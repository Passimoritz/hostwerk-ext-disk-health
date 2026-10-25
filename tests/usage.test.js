'use strict';
// Laufwerke 2.0, Teil „Belegung“: Verlauf im Server-Teil – einmal pro Stunde, alten Verlauf von „Speicher je Dienst“ einmal übernehmen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsage, mergeHistory } = require('../server/usage');

const G = 1073741824;
const DAY = 86400000;

test('usage: takes the old history over once, then one point per hour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-usage-'));
  let now = 100 * DAY;
  const old = { storage: { history: [{ t: now - 2 * DAY, used: 10 * G, total: 100 * G }, { t: now - DAY, used: 11 * G, total: 100 * G }] }, settings: null, at: 1 };
  let disk = { total: 100 * G, free: 88 * G };
  const u = createUsage({ dir, now: () => now, get: async () => ({ disk }), oldStorage: () => old });
  assert.strictEqual(u.takeOver(), true);
  assert.strictEqual(u.view().history.length, 2);
  assert.strictEqual(u.takeOver(), false, 'only once');
  await u.sample();
  assert.strictEqual(u.view().history.length, 3);
  now += 60000; disk = { total: 100 * G, free: 87 * G };
  await u.sample();
  assert.strictEqual(u.view().history.length, 3, 'not twice within an hour');
  now += 3600000;
  await u.sample();
  assert.strictEqual(u.view().history.length, 4);
  assert.strictEqual(u.view().history[3].used, 13 * G);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usage: merging sorts, drops duplicates, broken and old points', () => {
  const now = 200 * DAY;
  const m = mergeHistory([{ t: now - DAY, used: 2, total: 9 }, { t: now - 100 * DAY, used: 1, total: 9 }], [{ t: now - DAY, used: 5, total: 9 }, { t: now - 2 * DAY, used: 1, total: 9 }, { t: 'x' }, null], now);
  assert.deepStrictEqual(m.map((p) => p.t), [now - 2 * DAY, now - DAY]);
});
