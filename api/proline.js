// api/proline.js
// Reader: serves the cached projects to the dashboards instantly.
// Reads projects-cache.json from GitHub (no Vercel Blob, no live ProLine call).

const GH_OWNER  = 'thamerowead';
const GH_REPO   = 'mim';
const GH_BRANCH = 'main';
const CACHE_PATH = 'data/projects-cache.json';

const FETCH_TIMEOUT = 6000;

async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  // CORS / preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Read raw cache from GitHub. Token auth lets us read fast & avoid CDN lag.
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${CACHE_PATH}?ref=${GH_BRANCH}`;
    const ghRes = await timedFetch(url, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'mim-proline'
      }
    }, FETCH_TIMEOUT);

    if (ghRes.status === 404) {
      // cache not built yet
      return res.status(200).json({ updated: null, total: 0, projects: [] });
    }
    if (!ghRes.ok) {
      throw new Error(`GitHub read failed: ${ghRes.status}`);
    }

    const meta = await ghRes.json();
    const decoded = Buffer.from(meta.content, 'base64').toString('utf8');
    const data = JSON.parse(decoded);

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err), projects: [] });
  }
}
