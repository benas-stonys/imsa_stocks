const {createClient}=require('@supabase/supabase-js');
let client;
async function budgetFetch(url,options={},purpose='interactive',db) {
  db ||= client ||= createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  const slot=await db.rpc('claim_market_api_slot',{p_purpose:purpose});
  if(slot.error || slot.data!==true) throw Error('Market data is busy. Your pending orders will be checked again automatically.');
  return fetch(url,options);
}
module.exports={budgetFetch};
