'use strict';
// Drive health – every visible English text of the interface and the server has a German translation in locales/de.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../server/texts');

const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'de.json'), 'utf8'));
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'");

/** English texts from the interface source: t('…'), pl(n, '…', '…'), text props, JSX text, the label maps. */
function uiTexts() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'src', 'index.jsx'), 'utf8');
  const out = new Set();
  const add = (s) => { const v = unescape(s).trim(); if (/[A-Za-z]{2}/.test(v)) out.add(v); };
  for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) add(m[1]);
  for (const m of src.matchAll(/\bpl\([^,]+,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/g)) { add(m[1]); add(m[2]); }
  for (const m of src.matchAll(/\b(?:title|text|confirm|tipTitle)(?:=|: )'((?:[^'\\]|\\.)*)'/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:title|text|tipTitle)="([^"]+)"/g)) add(m[1]);
  for (const m of src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) if (!/[=;()]|=>/.test(m[1])) add(m[1]);
  // LEVEL/MEDIA/REASON: label: '…' and 'key': '…' inside the maps
  for (const name of ['LEVEL', 'MEDIA', 'REASON']) {
    const block = src.slice(src.indexOf(`const ${name} = {`), src.indexOf('};', src.indexOf(`const ${name} = {`)));
    for (const m of block.matchAll(/(?:label: |: )'((?:[^'\\]|\\.)*)'/g)) add(m[1]);
  }
  return [...out];
}

/** Texts of the server part: notifications, problem sentences, value names and explanations. */
function serverTexts() {
  const out = new Set([...Object.values(T.COUNTER_LABEL), ...Object.values(T.ATTR_LABEL), ...Object.values(T.ATTR_INFO)]);
  for (const f of ['texts.js', 'index.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
    for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) out.add(unescape(m[1]));
  }
  return [...out];
}

test('Jeder sichtbare Text der Oberfläche hat eine deutsche Übersetzung', () => {
  const missing = uiTexts().filter((s) => !(s in de) && !['smartmontools', 'USB', 'NVMe SSD'].includes(s) && !/^[\w./-]+$/.test(s));
  assert.deepStrictEqual(missing, []);
});

test('Jeder Text des Server-Teils (Meldungen, Werte, Erklärungen) hat eine deutsche Übersetzung', () => {
  const missing = serverTexts().filter((s) => !(s in de));
  assert.deepStrictEqual(missing, []);
});

test('Platzhalter stimmen in beiden Sprachen überein', () => {
  for (const [en, deText] of Object.entries(de)) {
    if (en === '$patterns') continue;
    const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.strictEqual(vars(deText), vars(en), en);
  }
});
