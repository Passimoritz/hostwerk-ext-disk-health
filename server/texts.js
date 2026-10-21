'use strict';
/*
 * Plain-language text for a problem – shared by the server (notifications, host.t) and the interface (t from
 * @hostwerk/i18n). English is the source, German comes from locales/de.json.
 */
const COUNTER_LABEL = {
  readErrors: 'Uncorrected read errors',
  writeErrors: 'Uncorrected write errors',
  reallocated: 'Reallocated sectors',
  pending: 'Sectors waiting for reallocation',
  uncorrectable: 'Unreadable sectors',
  mediaErrors: 'Media errors',
  crcErrors: 'Transfer errors (cable)',
  ioErrors: 'I/O errors',
};

/** One problem from health.assess() as a sentence. t = translator (text, vars) → text. */
function describe(p, t) {
  switch (p.code) {
    case 'health': return p.level === 'err' ? t('The drive reports itself as failing – back up your data now.') : t('The drive reports a problem with its health.');
    case 'critical': return t('The drive raises a critical warning (code {code}) – back up your data now.', { code: p.value });
    case 'spare': return t('The spare area is almost used up – replace the drive soon.');
    case 'temp': return p.level === 'err' ? t('{n} °C – much too hot.', { n: p.value }) : t('{n} °C – warmer than it should be.', { n: p.value });
    case 'wear': return p.level === 'err' ? t('{n} % worn – replace it soon.', { n: p.value }) : t('{n} % worn.', { n: p.value });
    case 'pending': return t('Sectors waiting to be reallocated: {n}.', { n: p.value });
    default: {
      const k = String(p.code).replace(/^grow:/, '');
      return t('{label} rose from {before} to {after}.', { label: t(COUNTER_LABEL[k] || k), before: p.before, after: p.value });
    }
  }
}

module.exports = { describe, COUNTER_LABEL };
