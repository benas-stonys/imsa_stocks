exports.handler = async function (event) {
  const ticker = event.queryStringParameters?.ticker;
  if (!ticker) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing ticker' }) };
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker.toUpperCase()}&token=${apiKey}`);
  const data = await res.json();

  if (!data || data.c === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Ticker not found' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ticker: ticker.toUpperCase(),
      price: data.c,
      prevClose: data.pc,
    }),
  };
};
