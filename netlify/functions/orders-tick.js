const {createClient}=require('@supabase/supabase-js');
const {fetchMarketQuote}=require('./lib/market-trade');
const {budgetFetch}=require('./lib/finnhub-budget');
const {evaluate,eastern}=require('./lib/order-rules');
async function run(db,{now=Date.now(),quote=(s)=>fetchMarketQuote(s,{fetchImpl:(url,options)=>budgetFetch(url,options,'monitor',db)})}={}) {
 const et=eastern(now);
 if(!et.weekday || et.minute<570 || et.minute>976)return {checked:0};
 const pending=await db.from('order_tickets').select('*').eq('status','open').order('checked_at',{nullsFirst:true}).order('created_at').limit(200);
 if(pending.error)throw Error('Could not load pending tickets.');
 if(!pending.data.length)return {checked:0};
 const symbols=[...new Set(pending.data.flatMap(t=>[...t.state.legs.filter(l=>l.status==='open').map(l=>l.ticker),...(t.state.trigger&&!t.state.triggered?[t.state.trigger.ticker]:[])]))];
 const saved=await db.from('stocks').select('*').in('ticker',symbols).order('price_checked_at',{nullsFirst:true}).order('ticker');
 if(saved.error)throw Error('Could not load order prices.');
 const quotes={},deadline=Date.now()+18000;
 let used=0;
 for(const s of saved.data) {
  if(s.is_overridden){quotes[s.ticker]={price:Number(s.current_price),asOf:s.last_updated,source:'classroom'};continue;}
  if(used>=20 || Date.now()>deadline)continue;
  used++;
  try {
   const q=await quote(s);
   const written=await db.from('stocks').update({current_price:q.price,last_updated:q.asOf,price_checked_at:new Date(now).toISOString()}).eq('ticker',s.ticker).eq('is_overridden',false).lte('last_updated',q.asOf);
   if(written.error)throw Error('Could not save quote.');
   quotes[s.ticker]=q;
  }catch{await db.from('stocks').update({price_checked_at:new Date(now).toISOString()}).eq('ticker',s.ticker);}
 }
 let checked=0;
 for(const ticket of pending.data) {
  if(Date.now()>deadline+5000)break;
  const next=evaluate(ticket.state,quotes,now);
  const result=await db.rpc('apply_order_evaluation',{p_id:ticket.id,p_version:ticket.version,p_state:next.state,p_fills:next.fills});
  if(result.error)throw Error('Order processing failed. No unconfirmed fills will be retried with new IDs.');
  checked++;
 }
 return {checked,quoted:Object.keys(quotes).length};
}
exports.run=run;
exports.handler=async()=>({statusCode:200,body:JSON.stringify(await run(createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})))});
