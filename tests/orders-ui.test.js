const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {JSDOM}=require('jsdom');
test('advanced ticket adds legs, changes conditionals, and retries an uncertain request with the same ID',async()=>{
 const dom=new JSDOM('<div id="host"></div>',{url:'https://test.invalid',runScripts:'outside-only'}),w=dom.window;
 w.eval(readFileSync('orders-ui.js','utf8'));
 const host=w.document.querySelector('#host'),calls=[];let fail=true;
 await w.OrdersUI.mount(host,{studentId:'alice',ticker:'AAPL',request:async body=>{
  if(body.action==='list')return {tickets:[],reserved_cash:0,available_cash:10000};
  calls.push(body);if(fail)throw Error('Connection lost');return {ticket:{id:body.ticket.request_id,status:'open'}};
 }});
 host.querySelector('.add-leg').click();assert.equal(host.querySelectorAll('.order-leg').length,2);
 const form=host.querySelector('form');form.elements.mode.value='contingent';form.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(host.querySelector('.order-trigger').hidden,false);
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.equal(calls.length,1);assert.ok(w.sessionStorage.getItem('advanced-ticket:alice'));assert.equal(form.elements.mode.disabled,true);
 fail=false;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.equal(calls[0].ticket.request_id,calls[1].ticket.request_id);assert.equal(w.sessionStorage.getItem('advanced-ticket:alice'),null);
 assert.match(host.textContent,/accepted/);dom.window.close();
});
