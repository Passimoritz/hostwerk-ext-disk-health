'use strict';
// Laufwerke, Teil „Dateien“ (server/files.js): Einlesen je Bereich, keine doppelte Zählung verschachtelter Bereiche,
// Papierkorb ausgelassen, Filter/Sortierung, Löschen und Umbenennen, Doppelte nach Inhalt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFiles, typeOf } = require('../server/files');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dh-files-'));
  const w = (rel, content, mtime) => {
    const f = path.join(base, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const big = Buffer.alloc(200000, 7);
  w('htdocs/index.html', '<h1>hi</h1>');
  w('htdocs/img/logo.png', Buffer.alloc(5000, 1));
  w('htdocs/img/copy-of-logo.png', Buffer.alloc(5000, 1));
  w('projekte/shop/package.json', '{}');
  w('projekte/app1/data.db', Buffer.alloc(3000, 2)); // gehört zum Bereich app:app1 (liegt im Projekte-Ordner)
  w('backups/db/main/2024.zip', big, Date.now() - 400 * 86400000);
  w('backups/db/main/2025.zip', big);
  w('backups/papierkorb/x/item', 'weg');
  const roots = [
    { id: 'htdocs', label: 'Webordner', kind: 'web', path: path.join(base, 'htdocs') },
    { id: 'projekte', label: 'Projekte', kind: 'project', path: path.join(base, 'projekte') },
    { id: 'app:app1', label: 'App: app1', kind: 'app', path: path.join(base, 'projekte', 'app1') },
    { id: 'backups', label: 'Sicherungen', kind: 'backup', path: path.join(base, 'backups') },
    { id: 'docker', label: 'Docker', kind: 'x', path: base, docker: true },
    { id: 'gone', label: 'Fehlt', kind: 'own', path: path.join(base, 'fehlt') },
  ];
  const trashed = [];
  const resolve = (root, rel) => {
    const r = roots.find((x) => x.id === root);
    if (!r) throw new Error('Unbekannter Bereich');
    const full = path.resolve(r.path, rel);
    if (!full.startsWith(path.resolve(r.path) + path.sep)) throw new Error('Pfad außerhalb des Bereichs');
    return { full };
  };
  const files = createFiles({
    roots: () => roots,
    resolve,
    toTrash: (root, rel) => { const { full } = resolve(root, rel); if (!fs.existsSync(full)) throw new Error('missing'); fs.rmSync(full); trashed.push(`${root}:${rel}`); return 'id'; },
    skip: [path.join(base, 'backups', 'papierkorb')],
  });
  return { base, files, trashed };
}

test('Art aus der Endung', () => {
  assert.strictEqual(typeOf('a.PNG'), 'image');
  assert.strictEqual(typeOf('latest.log'), 'log');
  assert.strictEqual(typeOf('server.log.gz'), 'log');
  assert.strictEqual(typeOf('world.zip'), 'archive');
  assert.strictEqual(typeOf('r.0.0.mca'), 'database');
  assert.strictEqual(typeOf('server.jar'), 'program');
  assert.strictEqual(typeOf('README'), 'other');
});

test('Einlesen: je Bereich, verschachtelte Bereiche nicht doppelt, Docker, fehlende Ordner und Papierkorb ausgelassen', async () => {
  const { files } = fixture();
  assert.strictEqual(files.summary().at, null);
  await files.scan();
  const s = files.summary();
  assert.deepStrictEqual(s.groups.map((g) => g.id), ['htdocs', 'projekte', 'app:app1', 'backups']);
  const by = Object.fromEntries(s.groups.map((g) => [g.id, g]));
  assert.strictEqual(by.htdocs.files, 3);
  assert.strictEqual(by.projekte.files, 1, 'app1 zählt bei der App, nicht im Projekte-Ordner');
  assert.strictEqual(by['app:app1'].files, 1);
  assert.strictEqual(by.backups.bytes, 400000, 'Papierkorb nie gezählt');
  assert.strictEqual(s.totals.files, 7);
  assert.strictEqual(s.totals.types.archive, 400000);
  assert.deepStrictEqual(by.htdocs.folders.map((f) => f.name), ['img', '']);
});

test('Liste: Filter nach Bereich, Ordner, Art, Suche, Größe, Alter – sortiert und in Seiten', async () => {
  const { files } = fixture();
  await files.scan();
  let r = files.list({});
  assert.strictEqual(r.total, 7);
  assert.strictEqual(r.items[0].size, 200000, 'größte zuerst');
  r = files.list({ root: 'htdocs', folder: 'img' });
  assert.deepStrictEqual(r.items.map((x) => x.name).sort(), ['copy-of-logo.png', 'logo.png']);
  r = files.list({ root: 'htdocs', folder: '' });
  assert.deepStrictEqual(r.items.map((x) => x.path), ['index.html']);
  assert.strictEqual(files.list({ type: 'image' }).total, 2);
  assert.strictEqual(files.list({ q: 'MAIN db' }).total, 2, 'Wörter in beliebiger Reihenfolge, ohne Groß/klein');
  assert.strictEqual(files.list({ minSize: 100000 }).total, 2);
  assert.deepStrictEqual(files.list({ olderThan: 365 }).items.map((x) => x.name), ['2024.zip']);
  r = files.list({ sort: 'name', order: 'asc', limit: 2, offset: 1 });
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.total, 7);
  assert.strictEqual(files.list({ root: 'htdocs,backups' }).total, 5);
});

test('Löschen in den Papierkorb nimmt die Dateien aus dem Index; Fehler je Datei', async () => {
  const { files, trashed } = fixture();
  await files.scan();
  const r = files.remove([{ root: 'htdocs', path: 'img/logo.png' }, { root: 'htdocs', path: 'fehlt.txt' }, { root: 'htdocs', path: '../projekte/shop/package.json' }, { bad: 1 }]);
  assert.strictEqual(r.done, 1);
  assert.strictEqual(r.failed.length, 2);
  assert.deepStrictEqual(trashed, ['htdocs:img/logo.png']);
  assert.strictEqual(files.list({ root: 'htdocs' }).total, 2);
});

test('Umbenennen im selben Ordner; ungültige Namen und belegte Ziele abgelehnt', async () => {
  const { base, files } = fixture();
  await files.scan();
  const r = files.rename({ root: 'htdocs', path: 'img/logo.png', name: 'brand.png' });
  assert.strictEqual(r.path, 'img/brand.png');
  assert.ok(fs.existsSync(path.join(base, 'htdocs', 'img', 'brand.png')));
  assert.strictEqual(files.list({ q: 'brand' }).total, 1);
  assert.throws(() => files.rename({ root: 'htdocs', path: 'index.html', name: '../x.html' }), /Invalid name/);
  assert.throws(() => files.rename({ root: 'htdocs', path: 'img/brand.png', name: 'copy-of-logo.png' }), /already exists/);
});

test('Doppelte: gleicher Inhalt ab der Mindestgröße, gleiche Größe mit anderem Inhalt nicht', async () => {
  const { base, files } = fixture();
  fs.writeFileSync(path.join(base, 'htdocs', 'same-size.bin'), Buffer.alloc(5000, 9));
  await files.scan();
  await files.findDuplicates({ minSize: 1000 });
  for (let i = 0; i < 200 && files.duplicates().running; i++) await new Promise((r) => setTimeout(r, 20));
  const d = files.duplicates();
  assert.strictEqual(d.running, false);
  const sets = d.groups.map((g) => g.files.map((f) => f.name).sort().join('|')).sort();
  assert.deepStrictEqual(sets, ['2024.zip|2025.zip', 'copy-of-logo.png|logo.png']);
  assert.strictEqual(d.waste, 205000);
  files.remove([{ root: 'htdocs', path: 'img/copy-of-logo.png' }]);
  assert.strictEqual(files.duplicates().groups.length, 1, 'Gruppe mit nur noch einer Datei fällt weg');
});
