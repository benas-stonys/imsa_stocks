const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {validateTicket,initialState,evaluate,nextClose}=require('../netlify/functions/lib/order-rules');
const now=Date.parse('2026-11-04T16:00:00Z');
const quote=(price,time=now)=>({price,source:'market',asOf:new Date(time).toISOString()});
const leg=(type='limit',more={})=>({ticker:'AAPL',action:'buy',shares:1,type,limit:100,...more});
const def=(mode='basket',legs=[leg()],extra={})=>validateTicket({request_id:randomUUID(),mode,tif:'gtc',legs,...extra});
const init=(d)=>initialState(d,{AAPL:quote(110),MSFT:quote(200)},now-60000);
test('limits, stop gaps, latched stop limits, trails, stale quotes and close orders',()=>{
 let s=init(def());assert.equal(evaluate(s,{AAPL:quote(101)},now).fills.length,0);assert.equal(evaluate(s,{AAPL:quote(99)},now).fills[0].price,99);
 s=init(def('basket',[leg('stop',{stop:120})]));assert.equal(evaluate(s,{AAPL:quote(130)},now).fills[0].price,130);
 s=init(def('basket',[leg('stop_limit',{stop:120,limit:125})]));let r=evaluate(s,{AAPL:quote(130)},now);assert.equal(r.fills.length,0);assert.equal(r.state.legs[0].stop_triggered,true);assert.equal(evaluate(r.state,{AAPL:quote(124)},now).fills.length,1);
 s=init(def('basket',[leg('trailing',{action:'sell',trail:10,trail_unit:'percent'})]));r=evaluate(s,{AAPL:quote(100)},now);r=evaluate(r.state,{AAPL:quote(120)},now);assert.equal(r.state.legs[0].stop,108);assert.equal(evaluate(r.state,{AAPL:quote(107)},now).fills.length,1);
 assert.equal(evaluate(init(def()),{AAPL:quote(90,now-3600000)},now).fills.length,0);
 assert.equal(evaluate(init(def()),{AAPL:quote(90)},Date.parse('2026-11-04T23:00Z')).fills.length,0);
 s=init(def('basket',[leg('close')]));assert.equal(evaluate(s,{AAPL:quote(99)},now).fills.length,0);
 const closing=Date.parse('2026-11-04T21:00:00Z');assert.equal(evaluate(s,{AAPL:quote(99,closing)},closing).fills.length,1);
 assert.equal(nextClose(Date.parse('2026-11-06T22:00Z')),'2026-11-09T21:00:00.000Z');
});
test('baskets are all-or-none, OCO cancels siblings, triggers wait for subsequent quotes',()=>{
 let s=init(def('basket',[leg(),leg('limit',{ticker:'MSFT',limit:190})]));assert.equal(evaluate(s,{AAPL:quote(99),MSFT:quote(200)},now).fills.length,0);assert.equal(evaluate(s,{AAPL:quote(99),MSFT:quote(189)},now).fills.length,2);
 s=init(def('oco',[leg(),leg()]));let r=evaluate(s,{AAPL:quote(90)},now);assert.equal(r.fills.length,1);assert.equal(r.state.legs[1].status,'cancelled');
 for(const mode of ['sequence','triggers_all','triggers_oco']){s=init(def(mode,[leg(),leg(),leg()]));r=evaluate(s,{AAPL:quote(90)},now);assert.equal(r.fills.length,1);assert.equal(r.state.legs[1].status,'open');assert.equal(r.state.legs[2].status,mode==='sequence'?'waiting':'open');}
 s=init(def('contingent',[leg()],{trigger:{ticker:'MSFT',direction:'above',price:210}}));r=evaluate(s,{AAPL:quote(90),MSFT:quote(211)},now);assert.equal(r.fills.length,0);assert.equal(r.state.triggered,true);assert.equal(evaluate(r.state,{AAPL:quote(90,now+60000)},now+60000).fills.length,1);
});
test('validation rejects impossible shapes and strips forged execution fields',()=>{
 assert.throws(()=>def('oco',[leg()]));assert.throws(()=>def('basket',[leg('trailing',{trail:100,trail_unit:'percent'})]));assert.throws(()=>def('basket',[leg('limit',{limit:NaN})]));assert.throws(()=>def('basket',[leg('limit',{shares:1.5})]));
 assert.equal(def('basket',[leg('market',{price:1,status:'filled'})]).legs[0].status,undefined);
});
test('database reservations, privacy, atomic fills, retries, cancellation, reset and rate budget',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to service_role;');
 await db.exec(readFileSync('supabase-schema.sql','utf8'));await db.exec('grant all on all tables in schema public to service_role;');
 for(const file of ['202609230001_market_trades.sql','202611040001_learning_features.sql','202611040002_advanced_orders.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 await db.exec(readFileSync('supabase/migrations/202611040002_advanced_orders.sql','utf8'));
 const a=randomUUID(),b=randomUUID();for(const [id,name] of [[a,'alice'],[b,'bob']]){await db.query('insert into auth.users values($1)',[id]);await db.query("insert into profiles(id,username,role) values($1,$2,'student')",[id,name]);await db.query('insert into portfolios(student_id) values($1)',[id]);}
 const action=async(actor,act,body={})=>(await db.query('select order_ticket_action($1,$2,$3) r',[actor,act,JSON.stringify(body)])).rows[0].r;
 const submit=async(d)=>action(a,'submit',{id:d.request_id,definition:d,state:init(d)});
 const trade=async(shares)=>db.query("select execute_journaled_trade($1,$2,'AAPL','buy',$3,100,now(),'market','')",[a,randomUUID(),shares]);
 let d=def('basket',[leg('limit',{shares:90})]),ticket=await submit(d);await submit(d);
 assert.equal((await action(a,'list')).tickets.length,1);assert.equal((await action(a,'list')).reserved_cash,9000);await assert.rejects(trade(11));assert.equal((await action(b,'list')).tickets.length,0);
 await action(b,'cancel',{id:d.request_id});assert.equal((await action(a,'list')).reserved_cash,9000);
 await action(a,'cancel',{id:d.request_id});await trade(11);
 assert.equal((await action(a,'list')).reserved_cash,0);
 await db.query('select reset_learning_history($1)',[a]);
 d=def('basket',[leg('limit',{shares:2}),leg('limit',{shares:3})]);ticket=await submit(d);
 const asOf=new Date().toISOString();await db.query("update stocks set current_price=99,last_updated=$1 where ticker='AAPL'",[asOf]);
 let evaluated=evaluate(ticket.state,{AAPL:quote(99)},now);evaluated.fills.forEach(f=>f.asOf=asOf);
 const apply=async()=>db.query('select apply_order_evaluation($1,$2,$3,$4) r',[ticket.id,ticket.version,JSON.stringify(evaluated.state),JSON.stringify(evaluated.fills)]);
 await apply();await apply();assert.equal(Number((await db.query('select cash from portfolios where student_id=$1',[a])).rows[0].cash),9505);assert.equal((await action(a,'list')).reserved_cash,0);
 assert.equal((await db.query('select count(*) n from trade_journals where student_id=$1',[a])).rows[0].n,3);
 d=def('basket',[leg('market',{shares:50}),leg('market',{shares:20})]);ticket=await submit(d);
 await db.query("update stocks set current_price=150,last_updated=$1 where ticker='AAPL'",[asOf]);evaluated=evaluate(ticket.state,{AAPL:quote(150)},now);evaluated.fills.forEach(f=>f.asOf=asOf);await apply();
 assert.equal(Number((await db.query('select cash from portfolios where student_id=$1',[a])).rows[0].cash),9505);assert.equal((await action(a,'list')).tickets.find(x=>x.id===ticket.id).status,'rejected');
 d=def();await submit(d);await db.query('select reset_learning_history($1)',[a]);assert.equal((await action(a,'list')).reserved_cash,0);assert.equal((await action(a,'list')).tickets.find(x=>x.id===d.request_id).status,'cancelled');
 for(let i=0;i<20;i++)assert.equal((await db.query("select claim_market_api_slot('monitor') ok")).rows[0].ok,true);
 assert.equal((await db.query("select claim_market_api_slot('monitor') ok")).rows[0].ok,false);
 for(let i=0;i<30;i++)assert.equal((await db.query("select claim_market_api_slot('interactive') ok")).rows[0].ok,true);
 assert.equal((await db.query("select claim_market_api_slot('interactive') ok")).rows[0].ok,false);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from order_tickets'));await assert.rejects(db.query('select order_ticket_action($1,\'list\',\'{}\')',[a]));
});
