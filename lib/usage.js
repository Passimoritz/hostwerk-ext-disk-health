// Laufwerke, Teil „Belegung“ (bis 1.5 Erweiterung „Speicher je Dienst“) – Logik ohne Seite: Server, Oberfläche und Tests
(function (root) {
  const DAY = 86400000;
  const locale = (lang) => (lang === 'en' ? 'en-US' : 'de-DE');
  function bytes(n, lang) { if (n == null || isNaN(n)) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let x = Number(n); while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; } return `${x.toLocaleString(locale(lang), { maximumFractionDigits: x >= 10 || i === 0 ? 0 : 1 })} ${u[i]}`; }
  /** Prozent mit einer Nachkommastelle in der Sprache von Hostwerk („12,5 %“ / „12.5 %“). */
  function percent(n, lang) { return `${Number(n || 0).toLocaleString(locale(lang), { maximumFractionDigits: 1 })} %`; }
  /** Anteile für Balken: je Dienst Prozent vom größten (Balkenlänge) und vom Gesamtverbrauch. */
  function shares(services) {
    const list = (services || []).filter((s) => s.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    const max = list[0] ? list[0].bytes : 1; const sum = list.reduce((a, s) => a + s.bytes, 0) || 1;
    return list.map((s) => ({ ...s, bar: Math.max(2, Math.round((s.bytes / max) * 100)), pct: Math.round((s.bytes / sum) * 1000) / 10 }));
  }
  /** Laufwerk: belegt in Prozent, Warnstufe ab 80 / 90 %. */
  function disk(d) { if (!d || !d.total) return null; const used = d.total - d.free; const pct = Math.round((used / d.total) * 100); return { used, free: d.free, total: d.total, pct, level: pct >= 90 ? 'err' : pct >= 80 ? 'warn' : 'ok' }; }

  /**
   * Verlauf der Laufwerksbelegung fortschreiben: höchstens ein Punkt pro Stunde, 90 Tage, 600 Punkte – passt locker in
   * den Speicher der Erweiterung (256 KB).
   */
  function record(history, dk, now = Date.now()) {
    const list = (Array.isArray(history) ? history : []).filter((p) => p && p.t > now - 90 * DAY && p.t <= now && p.used >= 0);
    if (!dk || !dk.total) return list;
    const last = list[list.length - 1];
    if (last && now - last.t < 3600000) return list;
    return [...list, { t: now, used: dk.used, total: dk.total }].slice(-600);
  }

  /**
   * Prognose aus dem Verlauf (lineare Regression der letzten 30 Tage): Zuwachs pro Tag und Tage bis voll.
   * null = noch zu wenig Verlauf (mindestens ein Tag); days null = wächst nicht (unter 1 MB pro Tag).
   */
  function forecast(history, now = Date.now()) {
    const pts = (history || []).filter((p) => p.t > now - 30 * DAY);
    if (pts.length < 2 || pts[pts.length - 1].t - pts[0].t < DAY) return null;
    const n = pts.length; const mx = pts.reduce((a, p) => a + p.t, 0) / n; const my = pts.reduce((a, p) => a + p.used, 0) / n;
    let num = 0; let den = 0;
    for (const p of pts) { num += (p.t - mx) * (p.used - my); den += (p.t - mx) ** 2; }
    const perDay = den ? (num / den) * DAY : 0;
    const last = pts[n - 1];
    if (perDay < 1048576) return { perDay, days: null, points: pts };
    return { perDay, days: Math.max(0, (last.total - last.used) / perDay), points: pts };
  }

  /** Wohin ein Klick auf einen Dienst führt: sein Dateien-Reiter (oder seine Seite), Sicherungen zu den Sicherungen. */
  function route(s, part) {
    const id = String((s && s.id) || '');
    const safe = /^[\w-]+$/.test(id);
    const backups = part === 'Sicherungen';
    switch (s && s.kind) {
      case 'minecraft': return safe ? `/mc/${id}/${backups ? 'backups' : 'files'}` : '/mc';
      case 'web': return safe ? `/web/${id}` : '/web';
      case 'app': return safe ? `/apps/${id}` : '/projects';
      case 'db': return backups ? '/sicherungen' : safe ? `/dbs/${id}` : '/dbs';
      // Spiele-Server (Erweiterung „Spiele-Server“) und Docker-Volumes – seit Hostwerk 3.0 in der Zählung
      case 'game': return safe ? `/spiele/${id}` : '/ext/game-servers';
      case 'docker': return s.app && /^[\w-]+$/.test(String(s.app)) ? `/apps/${s.app}` : '/apps';
      default: return '/files';
    }
  }

  /**
   * Aufräum-Vorschläge: Dienste, deren Sicherungen viel Platz brauchen (ab 1 GB und mindestens 40 % des Dienstes),
   * und bei vollem Laufwerk (ab 80 %) Hostwerks Zwischenspeicher. Höchstens vier, größte zuerst.
   */
  function tips(services, dk) {
    const out = [];
    for (const s of services || []) {
      const b = (s.parts || []).find((p) => p.label === 'Sicherungen');
      if (b && b.bytes >= 1073741824 && b.bytes >= s.bytes * 0.4) out.push({ kind: 'backups', name: s.name, bytes: b.bytes, route: route(s, 'Sicherungen') });
    }
    out.sort((a, b) => b.bytes - a.bytes);
    if (dk && dk.pct >= 80) out.push({ kind: 'cache', route: '/settings/erweitert' });
    return out.slice(0, 4);
  }

  /** Reihenfolge der Arten für den Filter: Dienste vor Docker-Volumes. */
  const KINDS = ['minecraft', 'game', 'web', 'db', 'app', 'docker', 'mail'];
  /**
   * Belegung je Art (Minecraft, Spiele-Server, Webserver, Datenbank, App, Docker …) für den Filter über der Liste:
   * [{ kind, bytes, count }] in fester Reihenfolge, unbekannte Arten hinten, leere weg.
   */
  function byKind(services) {
    const m = new Map();
    for (const s of services || []) { if (!s || !(s.bytes > 0)) continue; const k = String(s.kind || 'other'); const e = m.get(k) || { kind: k, bytes: 0, count: 0 }; e.bytes += s.bytes; e.count++; m.set(k, e); }
    const rank = (k) => { const i = KINDS.indexOf(k); return i < 0 ? KINDS.length : i; };
    return [...m.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || b.bytes - a.bytes);
  }

  const api = { bytes, percent, shares, disk, record, forecast, route, tips, byKind, KINDS, DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Disk = api;
})(typeof window !== 'undefined' ? window : globalThis);
