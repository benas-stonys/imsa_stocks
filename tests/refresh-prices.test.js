const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {refreshPrices}=require('../netlify/functions/lib/refresh-prices');

test('refresh retains overrides, rejects stale writes, rotates failures and reports the full backlog',async()=>{
 const writes=[],reads=[];
 const db={from(){let payload=null,filters=[];const q={select:()=>q,eq:(...a)=>{filters.push(a);return q;},order:(...a)=>{reads.push(a);return q;},limit:async()=>({data:[{ticker:'AAPL'},{ticker:'FAIL'},{ticker:'MSFT'}],count:43}),update:p=>{payload=p;return q;},lte:(...a)=>{filters.push(a);return q;},then:resolve=>{writes.push({payload,filters});return Promise.resolve({}).then(resolve);}};return q;}};
 const result=await refreshPrices(db,{quote:async stock=>{if(stock.ticker==='FAIL')throw new Error('Rate limited');return {price:123,prevClose:120,asOf:'2026-11-04T15:00:00Z'};}});
 assert.deepEqual(result,{updated:2,failed:1,deferred:40});
 assert.equal(reads[0][0],'price_checked_at');
 const prices=writes.filter(w=>w.payload.current_price);
 assert.equal(prices.length,2);
 assert.ok(prices.every(w=>w.filters.some(([key,value])=>key==='is_overridden'&&value===false)));
 assert.ok(prices.every(w=>w.filters.some(([key])=>key==='last_updated')));
 assert.equal(writes.filter(w=>w.payload.price_checked_at).length,3);
});

test('manual price refresh requires a verified administrator before fetching prices',async()=>{
 let role='student',calls=0;
 const db={auth:{getUser:async()=>({data:{user:{id:'actor'}}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:{role}})})})})};
 const exported={};vm.runInNewContext(fs.readFileSync('netlify/functions/fetch-stocks.js','utf8'),{exports:exported,process:{env:{}},require:name=>name==='@supabase/supabase-js'?{createClient:()=>db}:{refreshPrices:async()=>{calls++;return {updated:1};}}});
 const event={httpMethod:'POST',headers:{authorization:'Bearer token'}};
 assert.equal((await exported.handler({...event,headers:{}})).statusCode,401);
 assert.equal((await exported.handler(event)).statusCode,403);assert.equal(calls,0);
 role='admin';assert.equal((await exported.handler(event)).statusCode,200);assert.equal(calls,1);
});

test('research keeps the classroom execution price available through market-provider outages',async()=>{
 const exported={};
 const db={auth:{getUser:async()=>({data:{user:{id:'actor'}}})},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{name:'Apple',is_overridden:true,current_price:85}})})})})};
 vm.runInNewContext(fs.readFileSync('netlify/functions/stock-research.js','utf8'),{exports:exported,process:{env:{FINNHUB_API_KEY:'test'}},AbortSignal,fetch:async()=>{throw new Error('Provider offline');},require:name=>name==='@supabase/supabase-js'?{createClient:()=>db}:{SYMBOL:/^[A-Z]+$/}});
 const result=await exported.handler({httpMethod:'GET',headers:{authorization:'Bearer token'},queryStringParameters:{ticker:'AAPL'}});
 assert.equal(result.statusCode,200);const body=JSON.parse(result.body);assert.equal(body.quote.c,85);assert.equal(body.simulated,true);assert.deepEqual(body.metric,{});
});
