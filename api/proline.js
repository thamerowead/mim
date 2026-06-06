export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;

  if (!PARTNER_KEY || !COMPANY_KEY) {
    return res.status(500).json({ error: 'Missing API keys in environment variables' });
  }

  const { endpoint, body } = req.body || {};

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  try {
    const upstream = await fetch(`https://api.proline.app${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PARTNER_KEY': PARTNER_KEY,
        'COMPANY_KEY': COMPANY_KEY,
      },
      body: JSON.stringify(body || {}),
    });

    const data = await upstream.json();

    // ProLine returns { page, limit, total, results: [...] }
    const projects = Array.isArray(data)
      ? data
      : (data?.results || data?.projects || data?.data || []);

    // Diagnostics
    res.setHeader('x-proline-status', upstream.status);
    res.setHeader('x-proline-count', projects.length);
    res.setHeader('x-proline-total', (data && data.total != null) ? data.total : 'n/a');
    res.setHeader('x-proline-sent', JSON.stringify(body || {}));
    if (!Array.isArray(data)) {
      res.setHeader('x-proline-note', 'keys: ' + Object.keys(data).join(','));
    }

    return res.status(200).json(projects);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
