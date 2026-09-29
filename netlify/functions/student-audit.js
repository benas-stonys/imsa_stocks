const { createClient } = require('@supabase/supabase-js');
function createAuditHandler(getClient) {
  return async event => {
    const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed.' });
    const auth = event.headers?.authorization || event.headers?.Authorization || '';
    if (!/^Bearer \S+$/i.test(auth)) return reply(401, { error: 'Please sign in.' });
    try {
      const db = getClient();
      const user = await db.auth.getUser(auth.slice(7));
      if (user.error || !user.data?.user) return reply(401, { error: 'Please sign in again.' });
      const profile = await db.from('profiles').select('role').eq('id', user.data.user.id).single();
      if (profile.error || profile.data?.role !== 'admin') return reply(403, { error: 'Administrator access required.' });
      const { student = '', page = '0' } = event.queryStringParameters || {};
      if ((student && !/^[0-9a-f-]{36}$/i.test(student)) || !/^\d{1,6}$/.test(page)) return reply(400, { error: 'Invalid filter.' });
      const students = await db.from('profiles').select('id,username').eq('role','student').order('username');
      let query = db.from('transactions').select('id,student_id,ticker,action,shares,price,total_amount,cash_after,timestamp,price_source', { count: 'exact' });
      if (student) query = query.eq('student_id', student);
      const result = await query.order('timestamp', { ascending: false }).order('id', { ascending: false }).range(Number(page)*50, Number(page)*50+49);
      if (students.error || result.error) throw new Error('Query failed');
      return reply(200, { students: students.data, rows: result.data, count: result.count, page: Number(page) });
    } catch { return reply(503, { error: 'Audit history could not be loaded. Please retry.' }); }
  };
}
exports.createAuditHandler = createAuditHandler;
exports.handler = createAuditHandler(() => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }));
