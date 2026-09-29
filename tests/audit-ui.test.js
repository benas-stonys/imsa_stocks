const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {JSDOM}=require('jsdom');
test('admin audit renders safe student names, completed trades, and student filter',async()=>{
 const source=fs.readFileSync('app.js','utf8').replace(/^import .*;\r?\n/gm,'').replace('const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);','const supabase = {};').replace("window.addEventListener('DOMContentLoaded', start);",'');
 const dom=new JSDOM('<div id="app"></div>',{runScripts:'outside-only'});const w=dom.window;let requests=[];
 w.dataResponse={students:[{id:'abc',username:'<b>Student</b>'}],rows:[{student_id:'abc',ticker:'AAPL',action:'buy',shares:2,price:10,total_amount:20,cash_after:980,timestamp:'2026-09-29T15:00:00Z',price_source:'market'}],count:1};
 w.capture=p=>requests.push(p);
 w.eval(source+`; stockDataRequest=async path=>{window.capture(path);return window.dataResponse;}; app.innerHTML=renderAdminPanel({},[],[]); attachAuditLog();`);
 await new Promise(r=>setImmediate(r));assert.match(w.document.getElementById('audit-results').textContent,/BUY/);assert.match(w.document.getElementById('audit-results').textContent,/\$980.00/);assert.equal(w.document.querySelector('#audit-results b'),null);
 const select=w.document.getElementById('audit-student');select.value='abc';select.dispatchEvent(new w.Event('change'));await new Promise(r=>setImmediate(r));assert.match(requests.at(-1),/student=abc&page=0/);dom.window.close();
});
