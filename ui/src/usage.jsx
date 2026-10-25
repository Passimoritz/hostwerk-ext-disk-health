import { useEffect, useState } from 'react';
import { HardDrive, FolderOpen, RefreshCw, Trash2, Archive } from 'lucide-react';
import { useApi, fmtDate } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, InfoTip, TileEmpty } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import * as Kit from '@hostwerk/kit';
import D from '../../lib/usage.js';

/*
 * Laufwerke, Teil „Belegung“ (bis 1.5 eigene Erweiterung „Speicher je Dienst“): wie voll das Laufwerk ist, wie schnell es
 * wächst und wer den Platz belegt – je Dienst mit seinen Teilen (Server, Sicherungen, Daten …), Filter nach Art, Hinweise
 * zum Aufräumen. Die Größen zählt Hostwerk (/system/disk-usage, alle 10 Minuten), den Verlauf schreibt der Server-Teil
 * stündlich mit (server/usage.js). Texte Englisch, Deutsch aus locales/de.json.
 */
const KIND = { minecraft: 'Minecraft', game: 'Game server', web: 'Web server', db: 'Database', app: 'App', docker: 'Docker', mail: 'Mail server', other: 'Other' };
const PART = { Server: 'Server', Sicherungen: 'Backups', Daten: 'Data', Projekt: 'Project', Dokumente: 'Documents', 'Docker-Volume': 'Docker volume', Volumes: 'Volumes', Spielstände: 'Saves' };
// Sprache der Oberfläche (getLang aus @hostwerk/kit, ältere Hostwerk-Versionen: Deutsch) – für Zahlen und Größen
const lang = () => (typeof Kit.getLang === 'function' && Kit.getLang() === 'en' ? 'en' : 'de');
const kindLabel = (k) => t(KIND[k] || KIND.other);
const partLabel = (p) => (PART[p] ? t(PART[p]) : p);

/** Balken mit Wert für Bildschirmleser. */
function Bar({ pct, label, level = '' }) {
  return <div className="dh-du-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}><span className={level} style={{ width: `${pct}%` }} /></div>;
}

/** Kleiner Verlauf als Linie (letzte 30 Tage). */
function Spark({ points }) {
  if (!points || points.length < 2) return null;
  const t0 = points[0].t; const span = points[points.length - 1].t - t0 || 1; const max = Math.max(...points.map((p) => p.total || p.used)) || 1;
  const pts = points.map((p) => `${Math.round(((p.t - t0) / span) * 200)},${Math.round(40 - (p.used / max) * 38)}`).join(' ');
  return <svg className="dh-du-spark" viewBox="0 0 200 42" preserveAspectRatio="none" aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function forecastText(f) {
  if (!f) return t('The forecast appears once there is a day of history.');
  if (f.days == null) return t('The used space is not growing right now.');
  const days = Math.round(f.days);
  const per = t('+{size} per day', { size: D.bytes(f.perDay, lang()) });
  return `${per} · ${days <= 1 ? t('At this pace full in about a day') : t('At this pace full in about {n} days', { n: days })}`;
}

const go = (route) => { location.hash = route; };

/** Teil „Belegung“ der Seite. */
export function UsagePanel() {
  const u = useApi('/system/disk-usage', [], { live: false });
  const h = useApi('/disk-health/usage-history', [], { live: false });
  const [kind, setKind] = useState('');
  const d = u.data;
  // Hostwerk zählt gerade nach: in ein paar Sekunden noch einmal fragen
  useEffect(() => {
    if (!(d && d.computing && !(d.services || []).length)) return undefined;
    const tm = setTimeout(() => u.reload({ silent: true }), 4000);
    return () => clearTimeout(tm);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  if (u.error && !d) return <Callout kind="err" dismissible={false} title={t('The used space could not be loaded')}>{String(u.error)} <Btn className="sm" icon={RefreshCw} onClick={() => u.reload()}>Try again</Btn></Callout>;
  if (!d) return <Loading />;
  if (d.computing && !(d.services || []).length) return <Loading text={t('Hostwerk is counting the sizes – one moment …')} />;
  const list = D.shares(d.services);
  const dk = D.disk(d.disk);
  const kinds = D.byKind(d.services);
  const cur = kind && kinds.some((k) => k.kind === kind) ? kind : '';
  const shown = cur ? list.filter((s) => s.kind === cur) : list;
  const fc = D.forecast((h.data && h.data.history) || []);
  const driveLabel = dk ? t('{used} of {total} used', { used: D.bytes(dk.used, lang()), total: D.bytes(dk.total, lang()) }) : '';
  const tips = D.tips(list, dk);
  return (
    <div className="dh-du">
      {dk && (
        <div className="card card-pad dh-du-gap">
          <div className="row"><b className="grow">Drive</b><span className={`badge ${dk.level}`}>{D.percent(dk.pct, lang())}</span></div>
          <Bar pct={dk.pct} label={driveLabel} level={dk.level} />
          <div className="small muted">{driveLabel} · {t('{free} free', { free: D.bytes(dk.free, lang()) })}</div>
          <div className="dh-du-trend">
            <div className="grow"><div className="small"><b>History</b> <InfoTip pop title="History">Hostwerk notes how full the drive is once an hour – also while this page is closed – and estimates when it will be full.</InfoTip></div><div className={`small ${fc && fc.days != null && fc.days < 60 ? 'c-warn' : 'muted'}`}>{forecastText(fc)}</div></div>
            <Spark points={fc && fc.points} />
          </div>
        </div>
      )}
      {tips.length > 0 && (
        <div className="card card-pad dh-du-gap">
          <b>Make room</b>
          {tips.map((x) => (
            <div className="row dh-du-tip" key={`${x.kind}:${x.name || ''}`}>
              <span className="grow small">{x.kind === 'backups' ? t('The backups of {name} take {size}.', { name: x.name, size: D.bytes(x.bytes, lang()) }) : t('The drive is filling up – Hostwerk’s cache can be emptied safely.')}</span>
              <Btn className="sm" icon={x.kind === 'backups' ? Archive : Trash2} onClick={() => go(x.route)}>{x.kind === 'backups' ? t('Show backups') : t('Open the cache')}</Btn>
            </div>
          ))}
        </div>
      )}
      {kinds.length > 1 && (
        <div className="seg dh-du-gap dh-du-kinds" role="group" aria-label={t('Filter by kind')}>
          {[{ kind: '', bytes: kinds.reduce((a, k) => a + k.bytes, 0) }, ...kinds].map((k) => (
            <button type="button" key={k.kind || 'all'} className={k.kind === cur ? 'on' : ''} aria-pressed={k.kind === cur} onClick={() => setKind(k.kind)}>{k.kind ? kindLabel(k.kind) : t('All')} · {D.bytes(k.bytes, lang())}</button>
          ))}
        </div>
      )}
      <div className="card">
        {shown.length ? shown.map((s) => (
          <div className="list-item dh-du-item" key={`${s.kind}:${s.id || s.name}`}>
            <div className="grow dh-du-main">
              <div className="row-tight"><b className="grow ellipsis">{s.name}</b><span className="small muted">{kindLabel(s.kind)}</span><span className="small muted" title={t('Share of the space of all services')}>{D.percent(s.pct, lang())}</span><b>{D.bytes(s.bytes, lang())}</b></div>
              <Bar pct={s.bar} label={t('{name}: {pct} of the space of all services', { name: s.name, pct: D.percent(s.pct, lang()) })} />
              <div className="tiny muted">{(s.parts || []).map((p) => `${partLabel(p.label)}: ${D.bytes(p.bytes, lang())}`).join(' · ')}</div>
            </div>
            <Btn className="ghost sm icon" icon={FolderOpen} title={t('Open the folder of {name}', { name: s.name })} aria-label={t('Open the folder of {name}', { name: s.name })} onClick={() => go(D.route(s))} />
          </div>
        )) : <Empty icon={HardDrive} title="No services with data yet." />}
      </div>
      <p className="tiny muted">{t('As of {when} · counted again every 10 minutes', { when: d.at ? fmtDate(d.at) : '–' })}</p>
    </div>
  );
}

/** Für die Kachel: Füllstand des Laufwerks in einer Zeile (mit Warnung, wenn es bald voll ist). */
export function UsageLine() {
  const u = useApi('/system/disk-usage', [], { live: false });
  const h = useApi('/disk-health/usage-history', [], { live: false });
  const dk = u.data && D.disk(u.data.disk);
  if (!dk) return u.error ? <TileEmpty icon={HardDrive} text="The used space could not be loaded" /> : null;
  const fc = D.forecast((h.data && h.data.history) || []);
  const label = t('{used} of {total} used', { used: D.bytes(dk.used, lang()), total: D.bytes(dk.total, lang()) });
  return (
    <div className="dh-du-line">
      <div className="small">{label}</div>
      <Bar pct={dk.pct} label={label} level={dk.level} />
      {fc && fc.days != null && fc.days < 60 && <div className="tiny c-warn">{forecastText(fc)}</div>}
    </div>
  );
}
