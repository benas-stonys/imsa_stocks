const { createClient } = require('@supabase/supabase-js');
const { refreshPrices } = require('./lib/refresh-prices');
exports.handler = async event => {
  const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type':'application/json', 'cache-control':'no-store' }, body:JSON.stringify(body) });
  if (event.httpMethod !== 'POST') return reply(405,{error:'Method not allowed.'});
  const auth=event.headers?.authorization || event.headers?.Authorization || '';
  if (!/^Bearer \S+$/i.test(auth)) return reply(401,{error:'Please sign in.'});
  try {
    const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
    const user=await db.auth.getUser(auth.slice(7));
    if(user.error || !user.data?.user) return reply(401,{error:'Please sign in again.'});
    const profile=await db.from('profiles').select('role').eq('id',user.data.user.id).single();
    if(profile.error || profile.data?.role!=='admin') return reply(403,{error:'Administrator access required.'});
    return reply(200,await refreshPrices(db));
  } catch { return reply(503,{error:'Price refresh failed. Please retry.'}); }
};
