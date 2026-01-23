// Vercel Serverless Function - Submit Shotstack render job
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  // GET - check render status
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Missing render ID' });
    }

    try {
      const response = await fetch(`https://api.shotstack.io/stage/render/${id}`, {
        headers: {
          'x-api-key': apiKey,
          'Accept': 'application/json'
        }
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // POST - submit new render
  if (req.method === 'POST') {
    try {
      const response = await fetch('https://api.shotstack.io/stage/render', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(req.body)
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
