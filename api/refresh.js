// api/refresh.js
// Incremental collector: fetches ONE ProLine page per invocation,
// persists progress + final cache to GitHub (no Vercel Blob).
// Triggered by external cron (cron-job.org) every minute via ?key=CRON_SECRET

const GH_OWNER  = 'thamerowead';
const GH_REPO   = 'mim';
const GH_BRANCH = 'main';
const STATE_PATH = 'data/refresh-state.json';   // progress tracker
const CACHE_PATH = 'data/projects-cache.json';  // finished dataset dashboards read

const PROLINE_BASE   = 'https://api.proline.app';
const PROLINE_LIST   = '/v1/list/projects';
const PAGE_LIMIT     = 100;        // ProLine caps at 100 regardless
const FETCH_TIMEOUT  = 9000;       // stay under Vercel 10s hard cap

// ---------- small fetch helper with timeout ----------
async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- GitHub read ----------
async function ghGet(path) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`;
  const res = await timedFetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'mim-refresh'
    }
  }, FETCH_TIMEOUT);
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const decoded = Buffer.from(j.content, 'base64').toString('utf8');
  return { content: decoded, sha: j.sha };
}

// ---------- GitHub write ----------
async function ghPut(path, obj, sha) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
  const body = {
    message: `chore: update ${path} [skip ci]`,
    content: Buffer.from(JSON.stringify(obj)).toString('base64'),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const res = await timedFetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'mim-refresh',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, FETCH_TIMEOUT);
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- ProLine one page ----------
async function fetchProLinePage(page) {
  const res = await timedFetch(`${PROLINE_BASE}${PROLINE_LIST}`, {
    method: 'POST',
    headers: {
      'PARTNER_KEY': process.env.PARTNER_KEY,
      'COMPANY_KEY': process.env.COMPANY_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ page, limit: PAGE_LIMIT })
  }, FETCH_TIMEOUT);
  if (!res.ok) throw new Error(`ProLine page ${page} failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return { results: j.results || [], total: j.total ?? null };
}

export default async function handler(req, res) {
  // auth: accept ?key= or Authorization: Bearer
  const key = req.query.key ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (key !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    // 1. load state
    const stateFile = await ghGet(STATE_PATH);
    let state = stateFile.content
      ? JSON.parse(stateFile.content)
      : { page: 1, total: null, collected: [], done: false };

    // if previous run finished, start a fresh cycle
    if (state.done) {
      state = { page: 1, total: null, collected: [], done: false };
    }

    // 2. fetch exactly ONE page this invocation
    const { results, total } = await fetchProLinePage(state.page);
    if (total !== null) state.total = total;
    state.collected = state.collected.concat(results);

    // 3. completion check (rely on total, not short-page)
    const reachedTotal = state.total !== null && state.collected.length >= state.total;
    const emptyPage    = results.length === 0;

    if (reachedTotal || emptyPage) {
      // publish final cache
      const cacheFile = await ghGet(CACHE_PATH);
      await ghPut(CACHE_PATH, {
        updated: new Date().toISOString(),
        total: state.collected.length,
        projects: state.collected
      }, cacheFile.sha);

      // reset state for next cycle
      state.done = true;
      await ghPut(STATE_PATH, state, stateFile.sha);

      return res.status(200).json({
        ok: true, phase: 'complete',
        stored: state.collected.length, total: state.total
      });
    }

    // 4. not done — advance page, save state
    state.page += 1;
    await ghPut(STATE_PATH, state, stateFile.sha);

    return res.status(200).json({
      ok: true, phase: 'collecting',
      page: state.page - 1, collected: state.collected.length, total: state.total
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
