const {createClient}=require('@supabase/supabase-js');
const {SYMBOL,resolveStock}=require('./lib/stock-catalog');
function createOverrideHandler({getClient,resolve=resolveStock}) {
 return async event=>{
  const reply=(statusCode,body)=>({statusCode,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify(body)});
  if(event.httpMethod!=='POST')return reply(405,{error:'Method not allowed.'});
  const auth=event.headers?.authorization||event.headers?.Authorization||'';
  if(!/^Bearer \S+$/i.test(auth))return reply(401,{error:'Please sign in.'});
  let body;try{body=JSON.parse(event.body||'{}');}catch{return reply(400,{error:'Invalid request.'});}
  const ticker=String(body.ticker||'').trim().toUpperCase();const price=Number(body.price);
  if(!SYMBOL.test(ticker)||!Number.isFinite(price)||price<0.01||price>1000000000)return reply(400,{error:'Enter a valid ticker and a price between $0.01 and $1 billion.'});
  try{
   const db=getClient();const user=await db.auth.getUser(auth.slice(7));
   if(user.error||!user.data?.user)return reply(401,{error:'Please sign in again.'});
   const profile=await db.from('profiles').select('role').eq('id',user.data.user.id).single();
   if(profile.error||profile.data?.role!=='admin')return reply(403,{error:'Administrator access required.'});
   const saved=await db.from('stocks').select('*').eq('ticker',ticker).maybeSingle();
   if(saved.error)throw new Error('Lookup failed');
   let stock=saved.data;
   if(!stock){try{stock=await resolve(ticker);}catch{return reply(400,{error:'Ticker could not be verified. Check the symbol or retry shortly.'});}}
   const value=Math.round(price*10000)/10000;
   const row={ticker,name:stock.name,current_price:value,is_overridden:true,last_updated:new Date().toISOString()};
   if(!saved.data)row.prev_close=value;
   const result=await db.from('stocks').upsert(row,{onConflict:'ticker'});
   if(result.error)throw new Error('Save failed');
   return reply(200,{ticker,price:value});
  }catch{return reply(503,{error:'Override could not be saved. Please retry.'});}
 };
}
exports.createOverrideHandler=createOverrideHandler;
exports.handler=createOverrideHandler({getClient:()=>createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})});
