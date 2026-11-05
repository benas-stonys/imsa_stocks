const { randomUUID } = require('node:crypto');
const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing', 'close'];
const MODES = ['basket', 'oco', 'triggers_all', 'sequence', 'triggers_oco', 'contingent'];
const symbol = /^[A-Z0-9.^-]{1,20}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateTicket(body) {
  if (!body || !uuid.test(body.request_id || '') || !MODES.includes(body.mode) || !['day','gtc'].includes(body.tif) || !Array.isArray(body.legs) || body.legs.length < 1 || body.legs.length > 8) throw Error('Choose a valid ticket with 1–8 orders.');
  if ((body.mode === 'oco' && body.legs.length !== 2) || (body.mode === 'triggers_oco' && body.legs.length !== 3) || (['triggers_all','sequence'].includes(body.mode) && body.legs.length < 2)) throw Error('OCO needs two orders; Order 1 triggers OCO needs three; trigger groups need at least two.');
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0.0001 && value <= 1e9 && Math.abs(value*10000-Math.round(value*10000))<0.0001;
  const legs = body.legs.map(l => {
    if (!l || !symbol.test(l.ticker) || !['buy','sell'].includes(l.action) || !Number.isSafeInteger(l.shares) || l.shares < 1 || l.shares > 2147483647 || !TYPES.includes(l.type)) throw Error('Each order needs a stock, action, type and positive whole shares.');
    const leg = {ticker:l.ticker,action:l.action,shares:l.shares,type:l.type};
    for (const [field,needed] of [['limit',['limit','stop_limit'].includes(l.type)],['stop',['stop','stop_limit'].includes(l.type)],['trail',l.type==='trailing']]) {
      if (needed) { if (!number(l[field])) throw Error('Enter a positive price or trailing amount.'); leg[field]=l[field]; }
    }
    if (l.type==='trailing') { if (!['dollars','percent'].includes(l.trail_unit) || (l.trail_unit==='percent' && l.trail>=100)) throw Error('Choose a dollar trail or percentage below 100.'); leg.trail_unit=l.trail_unit; }
    return leg;
  });
  let trigger;
  if(body.mode==='contingent') { const t=body.trigger; if(!t || !symbol.test(t.ticker) || !['above','below'].includes(t.direction) || !number(t.price)) throw Error('Choose a stock-price trigger.'); trigger={ticker:t.ticker,direction:t.direction,price:t.price}; }
  if(typeof (body.rationale ?? '')!=='string' || (body.rationale || '').length>2000) throw Error('Keep your rationale under 2,000 characters.');
  return {request_id:body.request_id,mode:body.mode,tif:body.tif,legs,rationale:body.rationale || '',...(trigger?{trigger}:{})};
}
function eastern(now) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
  return {day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute),weekday:!['Sat','Sun'].includes(p.weekday)};
}
function nextClose(now) {
  // Classroom session ends at 4 pm Eastern. Quote freshness prevents holiday fills.
  for(let t=Math.floor(now/60000)*60000;t<now+4*86400000;t+=60000) {const e=eastern(t); if(t>now && e.weekday && e.minute===960) return new Date(t).toISOString();}
  throw Error('Could not determine classroom session.');
}
function initialState(def,quotes,now=Date.now()) {
  const expires=nextClose(now);
  return {mode:def.mode,tif:def.tif,trigger:def.trigger,triggered:false,created_at:new Date(now).toISOString(),expires_at:expires,legs:def.legs.map((l,i)=>{
    const q=quotes[l.ticker]; if(!q || !(q.price>0)) throw Error(`No usable quote for ${l.ticker}.`);
    return {...l,id:randomUUID(),status:i>0 && ['triggers_all','sequence','triggers_oco'].includes(def.mode)?'waiting':'open',activated_at:new Date(now).toISOString(),reserve_price:l.limit || Math.max(l.stop||0,q.price)*1.1,anchor:null,stop_triggered:false};
  })};
}
function fresh(q,leg,now,close=false) {
  if(!q || !Number.isFinite(q.price) || q.price<=0) return false;
  if(q.source==='classroom') return true;
  const asOf=Date.parse(q.asOf),e=eastern(asOf), current=eastern(now);
  return Number.isFinite(asOf) && asOf>=Date.parse(leg.activated_at) && asOf<=now+60000 && now-asOf<=15*60000 && e.day===current.day && e.weekday && e.minute>=570 && e.minute<=(close?960:959);
}
function evaluate(state,quotes,now=Date.now()) {
  const next=structuredClone(state), fills=[];
  const et=eastern(now), regular=et.weekday && et.minute>=570 && et.minute<960;
  const closeAt=Date.parse(next.expires_at);
  const open=next.legs.filter(l=>l.status==='open');
  if(next.tif==='day' && now>closeAt+15*60000) {next.legs.forEach(l=>{if(['open','waiting'].includes(l.status))l.status='expired';});return {state:next,fills};}
  if(next.mode==='contingent' && !next.triggered) {
    const t=next.trigger,q=quotes[t.ticker];
    if(!regular || !fresh(q,{activated_at:next.created_at},now) || !(t.direction==='above'?q.price>=t.price:q.price<=t.price)) return {state:next,fills};
    next.triggered=true;
    next.legs.forEach(l=>l.activated_at=new Date(now).toISOString());
    return {state:next,fills};
  }
  const ready=[];
  for(const l of open) {
    const q=quotes[l.ticker];
    if(l.type==='close') {
      if(now>=closeAt && now<=closeAt+15*60000 && fresh(q,l,now,true))ready.push(l);
      else if(now>closeAt+15*60000)l.status='expired';
      continue;
    }
    if(!regular || !fresh(q,l,now)) continue;
    if(l.type==='trailing') {
      l.anchor=l.anchor===null?q.price:(l.action==='sell'?Math.max(l.anchor,q.price):Math.min(l.anchor,q.price));
      const amount=l.trail_unit==='percent'?l.anchor*l.trail/100:l.trail;
      l.stop=l.action==='sell'?l.anchor-amount:l.anchor+amount;
    }
    if(['stop','stop_limit','trailing'].includes(l.type) && (l.action==='buy'?q.price>=l.stop:q.price<=l.stop))l.stop_triggered=true;
    const limitOK=!['limit','stop_limit'].includes(l.type) || (l.action==='buy'?q.price<=l.limit:q.price>=l.limit);
    const stopOK=!['stop','stop_limit','trailing'].includes(l.type) || l.stop_triggered;
    if(limitOK && stopOK)ready.push(l);
  }
  if(next.tif==='day' && now>=closeAt) next.legs.forEach(l=>{if(['open','waiting'].includes(l.status) && l.type!=='close')l.status='expired';});
  let chosen=ready.filter(l=>l.status==='open');
  const oco=next.mode==='oco' || (next.mode==='triggers_oco' && next.legs[0].status==='filled');
  if(oco)chosen=chosen.slice(0,1); // Stable ticket order breaks simultaneous trigger ties.
  if(['basket','contingent'].includes(next.mode) && chosen.length!==open.length)chosen=[];
  for(const l of chosen) {l.status='filled';fills.push({id:l.id,ticker:l.ticker,action:l.action,shares:l.shares,...quotes[l.ticker]});}
  if(chosen.length && oco)next.legs.forEach(l=>{if(l.status==='open')l.status='cancelled';});
  if(chosen.length) {
    const activate=l=>{l.status='open';l.activated_at=new Date(now).toISOString();};
    if(['triggers_all','triggers_oco'].includes(next.mode) && next.legs[0].status==='filled')next.legs.filter(l=>l.status==='waiting').forEach(activate);
    if(next.mode==='sequence') {const i=next.legs.findIndex(l=>l.status==='waiting');if(i>=0 && next.legs[i-1].status==='filled')activate(next.legs[i]);}
  }
  if(next.legs.some(l=>['expired','rejected'].includes(l.status))) next.legs.forEach(l=>{if(l.status==='waiting' || (['basket','contingent'].includes(next.mode) && l.status==='open'))l.status='cancelled';});
  return {state:next,fills};
}
module.exports={TYPES,MODES,validateTicket,initialState,evaluate,eastern,fresh,nextClose};
