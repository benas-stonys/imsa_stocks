const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup() {const dom=new JSDOM('<div id="host"></div>',{url:'https://test.invalid',runScripts:'outside-only'});dom.window.eval(fs.readFileSync('learning-ui.js','utf8'));return dom;}
const empty=()=>({watchlist:[],alerts:[],snapshots:[],assignments:[],scenarios:[]});

test('allocation values include numeric cash, concentration and unavailable prices',()=>{
 const dom=setup(),ui=dom.window.LearningUI;
 const result=ui.allocation({cash:'200',holdings:{AAPL:4}},[{ticker:'AAPL',current_price:200}]);
 assert.equal(result.total,1000);assert.equal(result.rows[1].percent,80);
 assert.match(ui.breakdown({cash:200,holdings:{AAPL:4}},[{ticker:'AAPL',current_price:200}]),/80.0% of your portfolio/);
 assert.match(ui.breakdown({cash:200,holdings:{UNKNOWN:4}},[]),/Allocation cannot be calculated/);
 dom.window.close();
});
test('performance has no invented history and uses a common benchmark starting date',()=>{
 const dom=setup(),ui=dom.window.LearningUI;
 assert.match(ui.performance([]),/next hourly snapshot/);
 const chart=ui.performance([{day:'2026-11-01',total_value:900,cash:100},{day:'2026-11-02',total_value:1000,cash:100,benchmark_price:500},{day:'2026-11-03',total_value:1100,cash:100,benchmark_price:550,contains_simulated:true}]);
 assert.match(chart,/Percentage change since 2026-11-02/);assert.match(chart,/2026-11-03: 10.00%/);
 assert.match(chart,/teacher-simulated prices/);assert.doesNotMatch(chart,/NaN/);
 dom.window.close();
});
test('research controls save watchlists and alerts, report failures, and escape provider text',async()=>{
 const dom=setup(),w=dom.window,host=w.document.getElementById('host'),calls=[],data=empty();
 const context={request:async(action,body)=>{calls.push({action,body});if(action==='load')return data;if(action==='watch.add')data.watchlist.push({ticker:body.ticker,name:'<img onerror=alert(1)>',current_price:100});return {ok:true};},portfolio:()=>({cash:1000,holdings:{}}),stocks:()=>[],students:()=>[],openStock:async()=>{}};
 await w.LearningUI.mount(host,'research',context);
 const form=host.querySelector('[data-learning-action="watch.add"]');form.elements.ticker.value=' aapl ';
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(calls.find(c=>c.action==='watch.add').body.ticker,'AAPL');assert.equal(host.querySelector('img'),null);
 assert.match(host.textContent,/<img onerror=alert\(1\)>/);
 const alert=host.querySelector('[data-learning-action="alert.add"]');alert.elements.ticker.value='AAPL';alert.elements.target.value='150';
 alert.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(calls.find(c=>c.action==='alert.add').body.target,'150');
 context.request=async()=>{throw new Error('Connection failed');};host.querySelector('[data-refresh-tools]').click();await tick();assert.match(host.textContent,/Connection failed/);
 dom.window.close();
});
test('student submits assignments/reflections; admin reviews progress, feedback and schedules a jump',async()=>{
 const dom=setup(),w=dom.window,host=w.document.getElementById('host'),calls=[],data=empty();
 data.assignments=[{id:'assignment',title:'Research',instructions:'Why this company?'}];
 const context={request:async(action,body)=>{calls.push({action,body});if(action==='load')return data;if(action==='journal.list')return {rows:[{id:'trade',action:'buy',ticker:'AAPL',shares:1,price:100,rationale:'<script>bad</script>'}]};if(action==='assignment.review')return {rows:[{student_id:'s1',username:'Student',response:'Evidence',submitted_at:'2026-11-04T12:00:00Z'},{student_id:'s2',username:'New student'}]};return {ok:true};},portfolio:()=>({cash:1000,holdings:{}}),stocks:()=>[],students:()=>[],openStock:async()=>{}};
 await w.LearningUI.mount(host,'accounts',context);
 assert.equal(host.querySelector('script'),null);
 const form=host.querySelector('[data-learning-action="assignment.submit"]');form.elements.text.value='My response';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(calls.find(c=>c.action==='assignment.submit').body.text,'My response');
 const reflection=host.querySelector('[data-learning-action="journal.reflect"]');reflection.elements.text.value='My reflection';reflection.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(calls.find(c=>c.action==='journal.reflect').body.id,'trade');
 // Mount onto a new host to match navigation (old listeners must not be reused).
 host.replaceWith(w.document.createElement('div'));const adminHost=w.document.body.firstElementChild;
 await w.LearningUI.mount(adminHost,'admin',context);
 adminHost.querySelector('[data-review-assignment]').click();await tick();assert.match(adminHost.textContent,/Not submitted/);
 const feedback=adminHost.querySelector('[data-learning-action="assignment.feedback"]');feedback.elements.text.value='Good evidence';feedback.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(calls.find(c=>c.action==='assignment.feedback').body.student_id,'s1');
 const scenario=adminHost.querySelector('[data-learning-action="scenario.create"]');scenario.elements.title.value='Earnings';scenario.elements.ticker.value='nvda';scenario.elements.target_price.value='150';scenario.elements.starts_at.value='2026-12-01T12:00';scenario.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const body=calls.find(c=>c.action==='scenario.create').body;assert.equal(body.ticker,'NVDA');assert.equal(body.ends_at,body.starts_at);
 dom.window.close();
});
test('demo learning tools never access the database and reset with the demo',async()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'https://test.invalid',runScripts:'outside-only'}),w=dom.window;
 const app=fs.readFileSync('app.js','utf8').replace(/^import .*;\r?\n/gm,'').replace('const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);','const supabase = new Proxy({}, {get(){throw new Error("No database in demo");}});').replace("window.addEventListener('DOMContentLoaded', start);",'');
 w.eval(app+';loadResearchPanel=async()=>{};renderAuth=async()=>{};');w.startDemo();
 await w.classroomRequest('watch.add',{ticker:'AAPL'});assert.equal((await w.classroomRequest('load')).watchlist.length,1);
 w.document.getElementById('trade-rationale').value='Practice thesis';w.handleDemoTrade();
 assert.equal((await w.classroomRequest('journal.list')).rows[0].rationale,'Practice thesis');
 w.exitDemo();w.startDemo();assert.equal((await w.classroomRequest('load')).watchlist.length,0);
 assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);dom.window.close();
});
