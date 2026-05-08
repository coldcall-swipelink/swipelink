export default async function handler(req, res) {
  const apiKey = process.env.bc1ebd29df8497e799034ec7eaeae2464986673acec122f18502acd6a9b75470;
  const collectionId = '68063d6ee4f168da919e70c6';

  try {
    const response = await fetch(
      `https://api.webflow.com/v1/collections/${collectionId}/items?limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept-Version': '1.0'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Webflow API error: ${response.status}`);
    }

    const data = await response.json();
    res.status(200).json(data.items || []);
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
}
