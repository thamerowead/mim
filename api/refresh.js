// Vercel Serverless Function — INCREMENTAL REFRESH (free-tier safe, final)
// Saddle River Roofing — Sales Dashboards
//
// ROOT CAUSE (confirmed from Vercel logs): the free tier hard-caps every
// function at 10s. A single ProLine page can itself approach or exceed 10s once
// retries/backoff are counted (logs showed 4 POSTs to ProLine in one invocation
// reaching 10.03s -> FUNCTION_INVOCATION_TIMEOUT). So we cannot assume "collect
// a whole page per call" is safe either.
//
// FIX: a HARD time guard. Every invocation watches the clock and ALWAYS returns
// a response before ~8s, no matter what. Each fetch is itself aborted at 7s so a
// slow ProLine response can never drag us past the limit. No retry loop inside a
// single invocation. Progress (cursor + accumulated projects) is persisted in
// refresh-state.json so the next cron tick resumes exactly where this stopped.
// Once all projects are gathered, the list is published to projects-cache.json.
//
// Auth: CRON_SECRET via ?key=... or Authorization: Bearer.

const { put, list } = require('@vercel/blob');

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';
const CACHE_KEY = 'projects-cache.json';
const STATE_KEY = 'refresh-state.json';
const PAGE_LIMIT = 100;

const FETCH_TIMEOUT_MS = 7000; // abort a single ProLine fetch after this

async function readBlob(pathname, token){
  try {
    const { blobs } = await list({ prefix: pathname, token, limit: 1 });
    const hit = blobs.find(b => b.pathname === pathname) || blobs[0];
    if (!hit) return null;
    const r = await fetch(hit.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// One ProLine page fetch, aborted hard at FETCH_TIMEOUT_MS. No internal retry
// loop — if it fails, the caller lets the NEXT cron tick retry the same page.
async function fetchPageOnce(page, PARTNER_KEY, COMPANY_KEY){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // Auth + body format confirmed from the working proxy:
    //  - headers use PARTNER_KEY / COMPANY_KEY (NOT X-Partner-Key, NOT Bearer)
    //  - body carries ONLY page + limit; NO `endpoint` field (it lives in the URL).
    //    Sending `endpoint` makes ProLine reject the request with 400.
    const r = await fetch(PROLINE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PARTNER_KEY': PARTNER_KEY,
        'COMPANY_KEY': COMPANY_KEY
      },
      body: JSON.stringify({ page, limit: PAGE_LIMIT }),
      signal: ctrl.signal
    });
    if (!r.ok) return { ok: false, status: r.status };
    const data = await r.json();
    const results = Array.isArray(data) ? data
      : (data.results || data.data || data.projects || []);
    const total = (data && typeof data.total === 'number') ? data.total : null;
    return { ok: true, results, total };
  } catch (e) {
    return { ok: false, err: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function writeBlob(key, obj, token){
  return put(key, JSON.stringify(obj), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    token
  });
}

module.exports = async (req, res) => {

  // ---- Auth ----
  const secret = process.env.CRON_SECRET;
  const provided = (req.query && req.query.key)
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;
  const BLOB_TOKEN  = process.env.BLOB_READ_WRITE_TOKEN;
  if (!PARTNER_KEY || !COMPANY_KEY) { res.status(500).json({ error: 'Missing ProLine keys' }); return; }
  if (!BLOB_TOKEN) { res.status(500).json({ error: 'Missing BLOB_READ_WRITE_TOKEN' }); return; }

  const forceReset = req.query && (req.query.reset === '1' || req.query.reset === 'true');

  // ---- Load progress ----
  let state = forceReset ? null : await readBlob(STATE_KEY, BLOB_TOKEN);
  if (!state || !Array.isArray(state.accumulated) || typeof state.page !== 'number') {
    state = { page: 1, accumulated: [], total: null };
  }

  // ---- Collect EXACTLY ONE page per invocation ----
  // This is deliberate and explicit, NOT time-based. A single ProLine page takes
  // up to ~7s; one fetch + one Blob write stays safely under the 10s free-tier
  // wall. Doing more than one page per call is what caused the earlier timeout
  // (logs showed 4 POSTs in one invocation -> 10.03s). One page per tick removes
  // any dependence on how fast the network happens to be. The external cron calls
  // this every minute, so all pages are gathered within a few minutes.
  const out = await fetchPageOnce(state.page, PARTNER_KEY, COMPANY_KEY);

  if (!out.ok) {
    // Transient failure (429, abort, network): save progress, retry same page next tick.
    try { await writeBlob(STATE_KEY, state, BLOB_TOKEN); } catch (e) {}
    res.status(200).json({ ok: false, retry: true, page: state.page, collected: state.accumulated.length, reason: out.status || out.err });
    return;
  }

  const got = out.results || [];
  state.accumulated = state.accumulated.concat(got);
  if (out.total !== null) state.total = out.total;

  const reachedTotal = (state.total !== null && state.accumulated.length >= state.total);
  const shortPage = (got.length < PAGE_LIMIT);
  const done = reachedTotal || shortPage || got.length === 0;

  try {
    if (done) {
      // ---- Publish the finished cache, then reset progress for the next cycle ----
      await writeBlob(CACHE_KEY, {
        updated_at: new Date().toISOString(),
        total: state.total,
        count: state.accumulated.length,
        projects: state.accumulated
      }, BLOB_TOKEN);
      await writeBlob(STATE_KEY, { page: 1, accumulated: [], total: null }, BLOB_TOKEN);
      res.status(200).json({ ok: true, done: true, stored: state.accumulated.length, total: state.total });
    } else {
      // ---- Save progress, advance to next page for the next tick ----
      state.page = state.page + 1;
      await writeBlob(STATE_KEY, state, BLOB_TOKEN);
      res.status(200).json({ ok: true, done: false, nextPage: state.page, collected: state.accumulated.length, total: state.total });
    }
  } catch (e) {
    res.status(500).json({ error: 'Blob write failed: ' + String(e) });
  }
};
