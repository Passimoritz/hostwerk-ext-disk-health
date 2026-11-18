'use strict';
// Laufwerke, Teil „Papierkorb“ (server/bin.js): $I-Dateien lesen (Format 1 und 2), auflisten, zurücklegen,
// endgültig löschen, leeren – an einem nachgebauten $Recycle.Bin-Ordner im Temp-Verzeichnis.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBin, parseInfo, makeInfo } = require('../server/bin');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dh-bin-'));
  const bin = path.join(base, '$Recycle.Bin', 'S-1-5-21-1');
  fs.mkdirSync(bin, { recursive: true });
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const add = (id, rel, content, deleted) => {
    const from = path.join(home, rel);
    if (content === null) { fs.mkdirSync(path.join(bin, `$R${id}`)); fs.writeFileSync(path.join(bin, `$R${id}`, 'a.txt'), 'abc'); } else fs.writeFileSync(path.join(bin, `$R${id}`), content);
    fs.writeFileSync(path.join(bin, `$I${id}`), makeInfo({ size: content === null ? 3 : content.length, deleted, from }));
  };
  add('AAA111.txt', 'docs\\note.txt'.split('\\').join(path.sep), 'hello', Date.UTC(2026, 10, 1));
  add('BBB222.zip', 'big.zip', Buffer.alloc(5000, 1), Date.UTC(2026, 10, 10));
  add('CCC333', 'Ordner', null, Date.UTC(2026, 9, 1));
  fs.writeFileSync(path.join(bin, '$IDDD444.txt'), makeInfo({ size: 1, deleted: Date.now(), from: path.join(home, 'x.txt') })); // $R fehlt
  fs.writeFileSync(path.join(bin, 'desktop.ini'), '[.ShellClassInfo]');
  const b = createBin({ bins: async () => [bin, path.join(base, 'fehlt')], dirSize: (p) => (p.endsWith('$RCCC333') ? { bytes: 42, files: 2 } : null) });
  return { base, bin, home, b };
}

test('$I-Datei: Format 2 hin und zurück, Format 1, Unsinn', () => {
  const t = Date.UTC(2025, 0, 2, 3, 4, 5);
  const x = parseInfo(makeInfo({ size: 1234, deleted: t, from: 'C:\\Users\\a\\Bild.png' }));
  assert.deepStrictEqual(x, { size: 1234, deleted: t, from: 'C:\\Users\\a\\Bild.png' });
  const v1 = Buffer.alloc(24 + 520);
  v1.writeBigUInt64LE(1n, 0); v1.writeBigUInt64LE(7n, 8);
  Buffer.from('D:\\alt.txt', 'utf16le').copy(v1, 24);
  assert.strictEqual(parseInfo(v1).from, 'D:\\alt.txt');
  assert.strictEqual(parseInfo(Buffer.from('kaputt')), null);
});

test('Auflisten: neueste zuerst, Ordnergröße aus dem Index, halbe Einträge ausgelassen', async () => {
  const { b } = fixture();
  const l = await b.list();
  assert.strictEqual(l.count, 3);
  assert.deepStrictEqual(l.items.map((x) => x.name), ['big.zip', 'note.txt', 'Ordner']);
  const dir = l.items.find((x) => x.dir);
  assert.strictEqual(dir.size, 42);
  assert.strictEqual(dir.files, 2);
  assert.strictEqual(l.bytes, 5000 + 5 + 42);
  assert.ok(l.items[0].id.endsWith(':$IBBB222.zip'));
  assert.ok(!('info' in l.items[0]));
});

test('Zurücklegen an den alten Ort (Ordner wird angelegt), belegtes Ziel abgelehnt', async () => {
  const { b, home, bin } = fixture();
  const l = await b.list();
  const note = l.items.find((x) => x.name === 'note.txt');
  const zip = l.items.find((x) => x.name === 'big.zip');
  fs.writeFileSync(path.join(home, 'big.zip'), 'schon da');
  const r = b.restore([note.id, zip.id, 'X:$Igibtsnicht']);
  assert.strictEqual(r.done, 1);
  assert.strictEqual(r.failed.length, 2);
  assert.strictEqual(fs.readFileSync(path.join(home, 'docs', 'note.txt'), 'utf8'), 'hello');
  assert.ok(!fs.existsSync(path.join(bin, '$IAAA111.txt')));
  assert.ok(fs.existsSync(path.join(bin, '$RBBB222.zip')), 'belegt – bleibt im Papierkorb');
});

test('Endgültig löschen und leeren', async () => {
  const { b, bin } = fixture();
  assert.throws(() => b.remove(['x']), /List the recycle bin first/);
  const l = await b.list();
  const r = b.remove([l.items.find((x) => x.dir).id]);
  assert.strictEqual(r.done, 1);
  assert.ok(!fs.existsSync(path.join(bin, '$RCCC333')));
  const e = await b.empty();
  assert.strictEqual(e.done, 2);
  assert.strictEqual((await b.list()).count, 0);
  assert.ok(fs.existsSync(path.join(bin, 'desktop.ini')), 'nur Einträge, nichts sonst');
});
