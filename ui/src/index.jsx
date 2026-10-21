import { useState } from 'react';
import { Activity, HardDrive, RefreshCw, Thermometer, Gauge, Clock, Copy, AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import { post, useApi, fmtBytes, fmtDate } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, InfoTip, TileEmpty, Sparkline, toast } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import { describe, COUNTER_LABEL } from '../../server/texts';
import './style.css';

/*
 * Drive health: one card per drive (state, temperature with trend, wear, power-on hours, error counters, plain-language
 * problems) and a dashboard tile with the worst drive first. Values the system does not reveal stay "–".
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const LEVEL = {
  ok: { label: 'Healthy', icon: CheckCircle2, badge: 'ok' },
  warn: { label: 'Needs attention', icon: AlertTriangle, badge: 'warn' },
  err: { label: 'In danger', icon: XCircle, badge: 'err' },
  unknown: { label: 'Unknown', icon: HelpCircle, badge: '' },
};
const RANK = { err: 0, warn: 1, unknown: 2, ok: 3 };
const MEDIA = { nvme: 'NVMe SSD', ssd: 'SSD', hdd: 'Hard disk', unknown: 'Drive' };
const NOTES = {
  'needs-admin': ['Windows only reveals the health status to programs without administrator rights.', 'Temperature, wear and error counters appear when Hostwerk runs as administrator. The health status above is still reliable – Windows evaluates the drive’s own S.M.A.R.T. data for it.'],
  'install-smartctl': ['Only the basics are visible right now.', 'Install smartmontools (package “smartmontools”, program smartctl) for wear, error counters and the drive’s own health status.'],
  'smartctl-rights': ['smartctl may not open some drives.', 'Hostwerk needs read access to them, for example with: sudo setcap cap_sys_rawio,cap_sys_admin+ep $(command -v smartctl). The other drives are shown with the basics.'],
};
const byLevel = (a, b) => (RANK[a.level] ?? 2) - (RANK[b.level] ?? 2) || a.name.localeCompare(b.name);
const hours = (h) => (h == null ? '–' : h >= 48 ? t('{n} days', { n: Math.round(h / 24).toLocaleString() }) : `${h.toLocaleString()} h`);

function Fact({ icon: Icon, label, value, tip }) {
  return (
    <div className="dh-fact">
      <span className="tiny muted row-tight"><Icon size={13} aria-hidden="true" />{label}{tip && <InfoTip inline title={label}>{tip}</InfoTip>}</span>
      <b>{value}</b>
    </div>
  );
}

function DriveCard({ d, onRefresh }) {
  const lv = LEVEL[d.level] || LEVEL.unknown;
  const temps = (d.history || []).map((h) => h.tempC).filter((x) => x != null);
  const counters = Object.keys(COUNTER_LABEL).filter((k) => d[k] != null);
  const menu = (e) => contextMenu(e, [
    d.serial && { label: t('Copy serial number'), icon: Copy, onClick: () => navigator.clipboard.writeText(d.serial).then(() => toast.success('Copied')).catch(() => {}) },
    { label: t('Check now'), icon: RefreshCw, onClick: onRefresh },
  ]);
  return (
    <div className={`card dh-card dh-${d.level}`} onContextMenu={menu}>
      <div className="card-head">
        <HardDrive size={16} aria-hidden="true" />
        <h3 className="ellipsis grow" title={d.name}>{d.name}</h3>
        <span className={`badge ${lv.badge}`}><lv.icon size={12} aria-hidden="true" /> {t(lv.label)}</span>
      </div>
      <div className="card-body stack dh-body">
        <div className="tiny muted">{t(MEDIA[d.media] || 'Drive')}{d.bus && d.bus !== 'NVMe' ? ` · ${d.bus}` : ''}{d.sizeBytes ? ` · ${fmtBytes(d.sizeBytes)}` : ''}{d.status && d.status !== 'OK' ? ` · ${d.status}` : ''}</div>
        <div className="dh-facts">
          <Fact icon={Thermometer} label={t('Temperature')} value={d.tempC != null ? `${d.tempC} °C` : '–'} tip={d.tempMaxC ? t('The drive itself reports {n} °C as its upper limit.', { n: d.tempMaxC }) : null} />
          <Fact icon={Gauge} label={t('Wear')} value={d.wearPct != null ? `${d.wearPct} %` : '–'} tip={t('How much of the rated write volume of an SSD is used up. 100 % does not mean it dies, but it should be replaced soon after.')} />
          <Fact icon={Clock} label={t('Power-on time')} value={hours(d.powerOnHours)} />
        </div>
        {d.wearPct != null && <div className={`progress dh-wear dh-wear-${d.problems && d.problems.some((p) => p.code === 'wear') ? d.level : 'fine'}`} role="progressbar" aria-label={t('Wear')} aria-valuenow={d.wearPct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${Math.max(2, d.wearPct)}%` }} /></div>}
        {temps.length > 1 && <div className="row-tight"><Sparkline data={temps} width={160} height={28} color="var(--accent-2)" /><span className="tiny muted">{t('Temperature over the last {n} readings', { n: temps.length })}</span></div>}
        {d.problems && d.problems.length > 0 && (
          <ul className="dh-problems">
            {d.problems.map((p) => <li key={p.code} className={p.level === 'err' ? 'c-err' : 'c-warn'}>{p.level === 'err' ? <XCircle size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}<span>{describe(p, t)}</span></li>)}
          </ul>
        )}
        {counters.length > 0 && (
          <dl className="dh-counters small">
            {counters.map((k) => <div key={k}><dt className="muted">{t(COUNTER_LABEL[k])}</dt><dd>{d[k].toLocaleString()}</dd></div>)}
          </dl>
        )}
        {d.serial && <div className="tiny muted mono ellipsis" title={d.serial}>{t('Serial number')} {d.serial}</div>}
      </div>
    </div>
  );
}

function DiskHealthPage() {
  const st = useApi('/disk-health', [], { live: false });
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { st.setData(await post('/disk-health/refresh')); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const d = st.data;
  const drives = d ? [...d.drives].sort(byLevel) : [];
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Activity /> Drive health</h1>
          <p>Temperature, wear and errors of every drive – Hostwerk tells you when something gets worse.</p>
        </div>
        <div className="actions">
          <Btn className="primary" icon={RefreshCw} busy={busy} onClick={refresh}>Check now</Btn>
        </div>
      </div>
      {st.error && <Callout kind="err" dismissible={false}>{st.error}</Callout>}
      {d && d.error && <Callout kind="warn" dismissible={false} title="The drives could not be read">{d.error}</Callout>}
      {d && (d.notes || []).filter((n) => NOTES[n]).map((n) => <Callout key={n} kind="info" title={t(NOTES[n][0])}>{t(NOTES[n][1])}</Callout>)}
      {st.loading && !d ? <Loading /> : !d || !d.at ? (
        <Empty icon={HardDrive} title="Not checked yet" text="The first check runs shortly after Hostwerk starts – or right now." action={<Btn className="primary" icon={RefreshCw} busy={busy} onClick={refresh}>Check now</Btn>} />
      ) : (d.notes || []).includes('unsupported') ? (
        <Empty icon={HardDrive} title="Not available on this system" text="Drive health works on Windows and Linux, and wherever smartctl is installed." />
      ) : !drives.length ? (
        <Empty icon={HardDrive} title="No drives found" text="The system did not list any physical drive." />
      ) : (
        <>
          <div className="grid grid-2 dh-grid">{drives.map((x) => <DriveCard key={x.id} d={x} onRefresh={refresh} />)}</div>
          <p className="tiny muted row-tight dh-foot">
            {t('As of {when} · warns from {temp} °C and {wear} % wear', { when: fmtDate(d.at), temp: d.limits.tempWarn, wear: d.limits.wearWarn })}
            <InfoTip inline title="Notifications">Warnings go to Hostwerk’s notifications (Live → Alerts: push, Discord, ntfy, mail) and appear under Live → Watchers. Limits and the rhythm are in Settings → Notifications.</InfoTip>
          </p>
        </>
      )}
    </div>
  );
}

/** Dashboard tile: the worst drive first, at most four. */
function DiskHealthTile() {
  const st = useApi('/disk-health', [], { live: false });
  const d = st.data;
  if (st.loading && !d) return <div className="card-body"><div className="skeleton dh-skel" /></div>;
  if (!d || !d.at || !d.drives.length) return <TileEmpty icon={HardDrive} text="No drive checked yet" href="#/ext/disk-health" />;
  const drives = [...d.drives].sort(byLevel).slice(0, 4);
  return (
    <div className="card-body stack dh-tile">
      {drives.map((x) => {
        const lv = LEVEL[x.level] || LEVEL.unknown;
        return (
          <a key={x.id} className="row-tight dh-tile-row" href="#/ext/disk-health" title={x.problems && x.problems.length ? describe(x.problems[0], t) : t(lv.label)}>
            <lv.icon size={15} className={x.level === 'err' ? 'c-err' : x.level === 'warn' ? 'c-warn' : x.level === 'ok' ? 'c-ok' : 'muted'} aria-label={t(lv.label)} />
            <span className="grow ellipsis small">{x.name}</span>
            <span className="small muted">{x.tempC != null ? `${x.tempC} °C` : ''}{x.tempC != null && x.wearPct != null ? ' · ' : ''}{x.wearPct != null ? `${x.wearPct} %` : ''}</span>
          </a>
        );
      })}
    </div>
  );
}

export default {
  pages: { main: DiskHealthPage },
  slots: {
    'dashboard.tiles': [{ id: 'drives', title: 'Drive health', icon: HardDrive, size: 'third', Component: DiskHealthTile }],
  },
};
