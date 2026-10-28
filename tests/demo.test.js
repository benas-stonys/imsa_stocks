const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {JSDOM}=require('jsdom');
test('demo trades remain in memory, enforce balances, and reset on logout',async()=>{
 const d=new JSDOM('<div id="app"></div>',{url:'https://example.test',runScripts:'outside-only'});const w=d.window;
 const source=fs.readFileSync('app.js','utf8').replace(/^import .*;\r?\n/gm,'').replace('const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);','const supabase = new Proxy({}, {get(){throw new Error("Demo must not access Supabase");}});').replace("window.addEventListener('DOMContentLoaded', start);",'');
 w.eval(source+`; renderAuth=async()=>{}; loadResearchPanel=async()=>{}; window.state=()=>dashboardState;`);
 w.startDemo();w.document.querySelector('#trade-shares').value='2';w.handleDemoTrade();assert.equal(w.state().portfolio.cash,9640);assert.equal(w.state().portfolio.holdings.AAPL,2);
 w.document.querySelector('#trade-action').value='sell';w.document.querySelector('#trade-shares').value='3';w.handleDemoTrade();assert.equal(w.state().portfolio.holdings.AAPL,2);
 w.document.querySelector('#trade-shares').value='1000';w.handleDemoTrade();assert.equal(w.state().portfolio.cash,9640);
 assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);assert.equal(w.state().history.rows.length,1);
 w.exitDemo();assert.equal(w.state().profile,null);w.startDemo();assert.equal(w.state().portfolio.cash,10000);assert.deepEqual(Object.keys(w.state().portfolio.holdings),[]);assert.equal(w.state().history.rows.length,0);d.window.close();
});
