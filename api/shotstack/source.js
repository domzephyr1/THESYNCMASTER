// Vercel Serverless Function - Check Shotstack source status
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-api-key'];
  const { id } = req.query;

  if (!apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  if (!id) {
    return res.status(400).json({ error: 'Missing source ID' });
  }

  try {
    const response = await fetch(`https://api.shotstack.io/ingest/stage/sources/${id}`, {
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Source status error:', error);
    return res.status(500).json({ error: error.message });
  }
}
