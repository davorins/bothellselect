// utils/utmNormalizer.js
const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'];

function normalizeUtm(raw = {}) {
  const out = {};
  for (const key of UTM_KEYS) {
    const val = raw[`utm_${key}`] ?? raw[key];
    out[key] = val ? String(val).trim().toLowerCase().slice(0, 200) : undefined;
  }
  return out;
}

/**
 * Derive a source from referrer if no explicit utm_source was passed.
 */
function deriveSourceFromReferrer(referrer) {
  if (!referrer) return 'direct';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host.includes('instagram')) return 'instagram';
    if (host.includes('facebook') || host.includes('fb.')) return 'facebook';
    if (host.includes('google')) return 'google';
    if (host.includes('tiktok')) return 'tiktok';
    if (host.includes('twitter') || host.includes('x.com')) return 'twitter';
    return host;
  } catch {
    return 'direct';
  }
}

module.exports = { normalizeUtm, deriveSourceFromReferrer };
