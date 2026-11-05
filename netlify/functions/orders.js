const {createClient}=require('@supabase/supabase-js');
const {validateTicket,initialState}=require('./lib/order-rules');
const {resolveStock}=require('./lib/stock-catalog');
const {fetchMarketQuote}=require('./lib/market-trade');
function createOrdersHandler({getClient,quote=fetchMarketQuote,resolve=resolveStock}) {
 return async event=>{
  const reply=(statusCode,body)=>({statusCode,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify(body)});
  if(event.httpMethod!=='POST')return reply(405,{error:'Method not allowed.'});
  const token=(event.headers?.authorization||event.headers?.Authorization||'').match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return reply(401,{error:'Please sign in.'});
  let body;try{body=JSON.parse(event.body||'{}');}catch{return reply(400,{error:'Invalid ticket.'});}
  if(!['submit','list','cancel'].includes(body.action))return reply(400,{error:'Invalid action.'});
  let submitting=false;
  try {
   const db=getClient();const user=await db.auth.getUser(token);
   if(user.error||!user.data?.user)return reply(401,{error:'Please sign in again.'});
   const actor=user.data.user.id;
   const profile=await db.from('profiles').select('role').eq('id',actor).single();
   if(profile.error||profile.data?.role!=='student')return reply(403,{error:'A student account is required.'});
   let payload=body;
   if(body.action==='submit') {
    let def;try{def=validateTicket(body.ticket);}catch(e){return reply(400,{error:e.message,uncertain:false});}
    const existing=await db.from('order_tickets').select('*').eq('id',def.request_id).eq('student_id',actor).maybeSingle();
    if(existing.error)throw Error('Order service is unavailable.');
    if(existing.data) {
     const retry=await db.rpc('order_ticket_action',{p_actor:actor,p_action:'submit',p_body:{id:def.request_id,definition:def}});
     if(retry.error)return reply(409,{error:retry.error.message,uncertain:false});
     return reply(200,{ticket:retry.data});
    }
    const quotes={};
    const symbols=[...new Set([...def.legs.map(l=>l.ticker),...(def.trigger?[def.trigger.ticker]:[])])];
    for(const ticker of symbols) {
     const saved=await db.from('stocks').select('*').eq('ticker',ticker).maybeSingle();
     if(saved.error)throw Error('Stock lookup failed.');
     const stock=saved.data||await resolve(ticker),q=await quote(stock);quotes[ticker]=q;
     if(!saved.data) {const registered=await db.from('stocks').upsert([{ticker,name:stock.name,current_price:q.price,prev_close:q.prevClose||q.price,last_updated:q.asOf,is_overridden:false}],{onConflict:'ticker',ignoreDuplicates:true});if(registered.error)throw Error('Could not register this stock.');}
    }
    payload={id:def.request_id,definition:def,state:initialState(def,quotes)};
   }
   submitting=body.action==='submit';
   const result=await db.rpc('order_ticket_action',{p_actor:actor,p_action:body.action,p_body:payload});
   if(result.error)return reply(result.error.code==='P0001'?400:503,{error:result.error.code==='P0001'?result.error.message:'Order service unavailable. Retry the same ticket.',uncertain:submitting&&result.error.code!=='P0001'});
   return reply(200,body.action==='submit'?{ticket:result.data}:result.data);
  }catch(e){return reply(503,{error:submitting?'Could not confirm this ticket. Retry it to retrieve its result.':e.message,uncertain:submitting});}
 };
}
exports.createOrdersHandler=createOrdersHandler;
exports.handler=createOrdersHandler({getClient:()=>createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})});
