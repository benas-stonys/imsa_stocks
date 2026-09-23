const { createClient } = require('@supabase/supabase-js');
const { createHandler } = require('./lib/market-trade');

exports.handler = createHandler({
  getClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Trade service is not configured.');
    return createClient(url, key, { auth: { persistSession: false } });
  },
});
