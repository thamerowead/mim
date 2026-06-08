// Vercel Serverless Function — INCREMENTAL REFRESH (free-tier safe, final)
// Saddle River Roofing — Sales Dashboards
//
// ROOT CAUSE (confirmed from Vercel logs): the free tier hard-caps every
// function at 10s, and a single ProLine page (100 rows) takes ~7-8s to return
// (logs: 7.15s). Collecting all 402 in one invocation is impossible; even one
// full page leaves little margin, and an abort set below the page's own time
// cut it off (AbortError at 7s).
//
// FIX: collect ONE page per invocation. Request a small page (25) so ProLine
// returns faster when it honors the limit; if it caps at 100 anyway, the abort
// sits at 9s (just under the 10s wall, above the page's ~7s) so the page still
// finishes. The cache read is itself abort-guarded at 3s. Progress (cursor +
// accumulated projects) is persisted in refresh-state.json so the next cron tick
// resumes where this stopped. When all projects are gathered, the finished list
// is published to projects-cache.json. Completion relies on ProLine's reported
// `total`, so it never stops early and loses rows.
//
// Auth: CRON_SECRET via ?key=... or Authorization: Bearer.

const { put, list } = require('@vercel/blob');

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';
const CACHE_KEY = 'projects-cache.json';
const STATE_KEY = 'refresh-state.json';
const PAGE_LIMIT = 25;     // request size sent to ProLine.
// ProLine is documented to sometimes cap pages at 100 regardless of this value.
// Requesting 25 makes each page MUCH faster to return when honored (a 100-row
// page took 7.15s in logs; ~25 rows returns far quicker). The paging logic below
// adapts to whatever page size ProLine actually returns, so correctness holds
// whether ProLine honors 25 or caps at 100 — we just collect more/fewer pages.

const FETCH_TIMEOUT_MS = 9000; // abort a single ProLine fetch after this.

async function readBlob(pathname, token){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000); // cache read must be quick
  try {
    const { blobs } = await list({ prefix: pathname, token, limit: 1 });
    const hit = blobs.find(b => b.pathname === pathname) || blobs[0];
    if (!hit) return null;
    const r = await fetch(hit.url + '?t=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
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
  // Deliberate and explicit, NOT time-based. One ProLine page + one Blob write
  // stays under the 10s free-tier wall. The fetch is abort-guarded at 9s so a
  // slow page can never cross the limit; collecting more than one page per call
  // is what caused the original 10.03s timeout. The external cron calls this
  // every minute, so all pages are gathered within a few minutes.
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

  // Completion logic — designed to NEVER stop early and lose projects:
  //  - If ProLine reported a total, trust it: done only when we've collected it all.
  //  - If no total is available, fall back to "an empty or short page means the end".
  let done;
  if (state.total !== null) {
    done = state.accumulated.length >= state.total;
  } else {
    done = (got.length === 0) || (got.length < PAGE_LIMIT);
  }
  // Absolute safety: an empty page always ends the cycle (prevents infinite paging).
  if (got.length === 0) done = true;

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
