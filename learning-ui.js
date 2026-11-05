/* Classroom learning UI. Loaded before app.js; all account access is supplied by the app. */
window.LearningUI = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => Number(value).toLocaleString('en-US', { style:'currency', currency:'USD' });
  const date = value => value ? new Date(value).toLocaleString() : 'No due date';
  const textarea = (name, value, max = 4000, required = false) => `<textarea name="${name}" rows="3" maxlength="${max}" ${required ? 'required' : ''}>${escape(value)}</textarea>`;
  const noteForm = (action, id, label, value, student = '') => `<form data-learning-action="${action}"><input type="hidden" name="id" value="${escape(id)}"><input type="hidden" name="student_id" value="${escape(student)}"><label>${label}${textarea('text',value)}</label><button>Save ${label.toLowerCase()}</button></form>`;

  function allocation(portfolio, stocks) {
    const rows = [{ ticker:'Cash', value:Number(portfolio.cash) }];
    const missing = [];
    for (const [ticker, shares] of Object.entries(portfolio.holdings || {})) {
      if (!(Number(shares)>0)) continue;
      const stock = stocks.find(s => s.ticker === ticker);
      if (!stock || !Number.isFinite(Number(stock.current_price)) || Number(stock.current_price)<=0) { missing.push(ticker); continue; }
      rows.push({ ticker, value:Number(shares)*Number(stock.current_price), simulated:stock.is_overridden });
    }
    const total = rows.reduce((sum,r) => sum+r.value,0);
    return { rows:rows.map(r => ({ ...r, percent:total>0 ? r.value/total*100 : 0 })), total, missing };
  }
  function breakdown(portfolio, stocks) {
    const data = allocation(portfolio, stocks);
    if (data.missing.length) return `<section class="card"><h2>Portfolio breakdown</h2><p class="message error">Prices unavailable for ${data.missing.map(escape).join(', ')}. Allocation cannot be calculated yet.</p></section>`;
    const largest = [...data.rows].filter(r=>r.ticker!=='Cash').sort((a,b)=>b.percent-a.percent)[0];
    return `<section class="card"><p class="eyebrow">WHERE YOUR MONEY IS</p><h2>Portfolio breakdown</h2>
      ${data.rows.map(row=>`<div class="allocation-row"><div><strong>${escape(row.ticker)}</strong><span>${money(row.value)} · ${row.percent.toFixed(1)}%${row.simulated?' · Simulated price':''}</span></div><progress max="100" value="${row.percent}" aria-label="${escape(row.ticker)} allocation">${row.percent.toFixed(1)}%</progress></div>`).join('')}
      <p class="small-text">${largest && largest.percent>=40 ? `${largest.percent.toFixed(1)}% of your portfolio is in ${escape(largest.ticker)}. A move in this company can have a large effect on your account.` : 'Compare the share of your cash and investments as you build your portfolio.'} Values use the latest saved classroom prices.</p></section>`;
  }
  function performance(snapshots) {
    if (!snapshots.length) return '<section class="card"><h2>Portfolio performance</h2><p>Your history starts with the next hourly snapshot. Earlier values are not reconstructed.</p></section>';
    // Compare both series over the same dates; never bridge missing benchmark observations.
    const common = snapshots.findIndex(r=>Number(r.benchmark_price)>0 && Number(r.total_value)>0);
    const start = common<0 ? 0 : common;
    const rows = snapshots.slice(start), base = rows[0];
    const series = rows.map(r=>({ ...r, portfolio:Number(base.total_value)>0 ? (Number(r.total_value)/Number(base.total_value)-1)*100 : null,
      benchmark:common>=0 && Number(r.benchmark_price)>0 ? (Number(r.benchmark_price)/Number(base.benchmark_price)-1)*100 : null }));
    const values = series.flatMap(r=>[r.portfolio,r.benchmark]).filter(Number.isFinite);
    const low = Math.min(0,...values), high = Math.max(0,...values), spread = Math.max(high-low,1);
    const x = i => 55+(rows.length===1 ? 345 : i/(rows.length-1)*690);
    const y = v => 25+(high+.1*spread-v)/(spread*1.2)*210;
    const line = (key,color) => {
      let pen = false;
      const path = series.map((row,i)=>{ if(!Number.isFinite(row[key])) {pen=false;return '';} const cmd=pen?'L':'M';pen=true;return `${cmd}${x(i).toFixed(2)},${y(row[key]).toFixed(2)}`; }).join(' ');
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="3"/>` + series.filter(r=>Number.isFinite(r[key])).map(r=>{const i=series.indexOf(r);return `<circle cx="${x(i)}" cy="${y(r[key])}" r="3" fill="${color}"><title>${escape(r.day)}: ${r[key].toFixed(2)}%</title></circle>`;}).join('');
    };
    return `<section class="card"><p class="eyebrow">YOUR PROGRESS</p><h2>Portfolio performance</h2><p class="small-text">Percentage change since ${escape(base.day)}. Blue: your portfolio. Gold: SPY, an ETF tracking the S&amp;P 500 (price return, excluding dividends). Daily snapshots update hourly; dates use New York time.</p>
      ${values.length ? `<svg class="performance-chart" viewBox="0 0 800 280" role="img" aria-label="Portfolio and SPY percentage return chart"><line x1="55" y1="${y(0)}" x2="745" y2="${y(0)}" stroke="#a8b2c8" stroke-dasharray="4"/><text x="4" y="${y(high)+4}">${high.toFixed(1)}%</text><text x="4" y="${y(low)+4}">${low.toFixed(1)}%</text>${line('portfolio','#3b4fd1')}${line('benchmark','#a56b00')}<text x="55" y="270">${escape(base.day)}</text><text x="745" y="270" text-anchor="end">${escape(rows.at(-1).day)}</text></svg>` : '<p>A positive starting value is needed to calculate percentage returns.</p>'}
      ${rows.length===1?'<p class="small-text">First snapshot recorded. A trend will appear as more days are collected.</p>':''}
      ${common<0?'<p class="small-text">Benchmark data is unavailable. Your account history is still recorded.</p>':''}
      ${snapshots.some(r=>r.contains_simulated)?'<p class="message">This history includes teacher-simulated prices, so it is not a like-for-like market comparison.</p>':''}
      <details><summary>View recorded values</summary><div class="table-scroll"><table class="table"><thead><tr><th>Date</th><th>Total value</th><th>Cash</th><th>SPY</th><th>Captured</th></tr></thead><tbody>${snapshots.map(r=>`<tr><td>${escape(r.day)}</td><td>${money(r.total_value)}</td><td>${money(r.cash)}</td><td>${r.benchmark_price?money(r.benchmark_price):'Unavailable'}</td><td>${escape(date(r.captured_at))}</td></tr>`).join('')}</tbody></table></div></details></section>`;
  }
  function watchlist(data) {
    return `<section class="card"><p class="eyebrow">KEEP AN EYE ON THE MARKET</p><h2>My watchlist</h2><form data-learning-action="watch.add" class="learning-inline"><label>Stock symbol<input name="ticker" maxlength="20" placeholder="NVDA" required></label><button>Add stock</button></form>
      ${data.watchlist.length?`<div class="table-scroll"><table class="table"><thead><tr><th>Stock</th><th>Saved price</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${data.watchlist.map(s=>`<tr><td><button class="secondary" data-open-stock="${escape(s.ticker)}">${escape(s.ticker)}</button><small>${escape(s.name)}</small></td><td>${money(s.current_price)}${s.is_overridden?' · Simulated':''}</td><td>${escape(date(s.last_updated))}</td><td><button class="secondary" data-learning-action="watch.remove" data-ticker="${escape(s.ticker)}">Remove</button></td></tr>`).join('')}</tbody></table></div>`:'<p>Save stocks here before you decide to buy.</p>'}</section>`;
  }
  function alerts(data) {
    return `<section class="card"><h2>Price alerts</h2><p class="small-text">One-time in-app alerts, checked on the hourly refresh against saved prices. Above/below means at or beyond your target; this is not a real-time notification service. Teacher prices apply to overridden stocks.</p>
      <form data-learning-action="alert.add" class="learning-inline"><label>Symbol<input name="ticker" maxlength="20" placeholder="AAPL" required></label><label>Condition<select name="direction"><option value="above">At or above</option><option value="below">At or below</option></select></label><label>Target price<input name="target" type="number" min="0.01" max="1000000000" step="0.0001" required></label><button>Create alert</button></form>
      <ul class="learning-list">${data.alerts.map(a=>`<li class="${a.triggered_at&&!a.acknowledged?'unread-alert':''}"><div><strong>${escape(a.ticker)} ${escape(a.direction)} ${money(a.target)}</strong><p>${a.triggered_at?`Reached ${money(a.triggered_price)} · ${escape(date(a.triggered_at))}${a.acknowledged?' · Read':''}`:'Waiting for a fresh price update'}</p></div><div>${a.triggered_at&&!a.acknowledged?`<button class="secondary" data-learning-action="alert.ack" data-id="${escape(a.id)}">Mark read</button>`:''}<button class="secondary" data-learning-action="alert.remove" data-id="${escape(a.id)}">Remove</button></div></li>`).join('')||'<li>No alerts yet.</li>'}</ul></section>`;
  }
  function assignments(data, admin) {
    return `<section class="card"><p class="eyebrow">LEARN BY INVESTING</p><h2>Assignments${admin?' and feedback':''}</h2>
      ${admin?`<details><summary>Create an assignment</summary><form data-learning-action="assignment.create"><label>Title<input name="title" maxlength="120" required></label><label>Instructions${textarea('instructions','',6000,true)}</label><label>Due date (your local time, optional)<input name="due_at" type="datetime-local"></label><button>Publish to all students</button></form></details>`:''}
      ${data.assignments.map(a=>`<article class="learning-item"><h3>${escape(a.title)}</h3><p class="preserve-lines">${escape(a.instructions)}</p><p class="small-text">${escape(date(a.due_at))}${a.due_at&&Date.parse(a.due_at)<Date.now()?' · Past due; submissions still accepted':''}</p>
        ${admin?`<p>${Number(a.submitted_count)||0} submissions</p><button class="secondary" data-review-assignment="${escape(a.id)}">Review student progress</button> <button class="secondary" data-learning-action="assignment.archive" data-id="${escape(a.id)}">Close assignment</button><div data-review-container="${escape(a.id)}"></div>`:
          `<p>${a.submitted_at?`Submitted ${escape(date(a.submitted_at))}${a.reviewed_at?' · Reviewed':' · Awaiting feedback'}`:'Not submitted'}</p>${a.feedback?`<blockquote><strong>Teacher feedback</strong><p class="preserve-lines">${escape(a.feedback)}</p></blockquote>`:''}<form data-learning-action="assignment.submit"><input type="hidden" name="id" value="${escape(a.id)}"><label>Your response${textarea('text',a.response,10000,true)}</label><p class="small-text">Resubmitting replaces your response and sends it for a new review.</p><button>${a.submitted_at?'Resubmit response':'Submit response'}</button></form>`}</article>`).join('')||'<p>No open assignments.</p>'}</section>`;
  }
  function scenarios(data) {
    return `<section class="card"><p class="eyebrow">TEACHER SIMULATION</p><h2>Price scenario builder</h2><p>Start with a stock you have overridden in Manage stocks. Schedule a jump or a gradual move toward a target price.</p><p class="small-text">Scenarios apply to all students. Updates run hourly, about 10 minutes past the hour, and may be delayed. A gradual move uses elapsed time from the starting override to the target. The final price stays overridden. Cancelling holds the last price; a new manual override cancels the scenario.</p>
      <form data-learning-action="scenario.create"><div class="grid grid-2"><label>Scenario name<input name="title" maxlength="120" placeholder="Earnings surprise" required></label><label>Overridden stock symbol<input name="ticker" maxlength="20" placeholder="NVDA" required></label><label>Movement<select name="kind"><option value="jump">Jump to target</option><option value="linear">Gradual linear move</option></select></label><label>Target price<input name="target_price" type="number" min="0.01" max="1000000000" step="0.0001" required></label><label>Start (your local time)<input name="starts_at" type="datetime-local" required></label><label>Finish (gradual moves only)<input name="ends_at" type="datetime-local"></label></div><button>Schedule scenario</button></form>
      ${data.scenarios.map(s=>`<article class="learning-item"><h3>${escape(s.title)} · ${escape(s.ticker)}</h3><p>${escape(s.kind)}: ${money(s.start_price)} → ${money(s.target_price)} · <strong>${escape(s.status)}</strong></p><p class="small-text">${escape(date(s.starts_at))} → ${escape(date(s.ends_at))}</p>${['scheduled','active'].includes(s.status)?`<button class="secondary" data-learning-action="scenario.cancel" data-id="${escape(s.id)}">Cancel and hold current price</button>`:''}</article>`).join('')}</section>`;
  }
  function journal(rows, admin, page) {
    return `<h2>${admin?'Student trade journals':'My trade journal'}</h2>
      ${rows.map(r=>`<article class="learning-item"><h3>${admin?`${escape(r.username)} · `:''}${escape(r.action.toUpperCase())} ${Number(r.shares)} ${escape(r.ticker)} @ ${money(r.price)}</h3><p class="small-text">${escape(date(r.timestamp))}</p><p class="preserve-lines"><strong>Original reasoning:</strong> ${escape(r.rationale)||'No note recorded.'}</p>
        ${admin?`<p class="preserve-lines"><strong>Student reflection:</strong> ${escape(r.reflection)||'No reflection yet.'}</p>${noteForm('journal.feedback',r.id,'Teacher feedback',r.feedback)}`:`${r.feedback?`<blockquote><strong>Teacher feedback</strong><p class="preserve-lines">${escape(r.feedback)}</p></blockquote>`:''}${noteForm('journal.reflect',r.id,'Reflection',r.reflection)}`}</article>`).join('')||'<p>No trades on this page.</p>'}
      <div class="audit-pagination"><button class="secondary" data-journal-page="${page-1}" ${page===0?'disabled':''}>Previous</button><span>Page ${page+1}</span><button class="secondary" data-journal-page="${page+1}" ${rows.length<25?'disabled':''}>Next</button></div>`;
  }
  async function mount(host, mode, context) {
    let page=0, student='';
    const admin=mode==='admin';
    host.innerHTML='<section class="card" role="status">Loading classroom tools…</section>';
    const renderJournal = async () => {
      const target=host.querySelector('[data-journal]'); if(!target) return;
      target.textContent='Loading trade notes…';
      try { const result=await context.request('journal.list',{page,student_id:student}); if(target.isConnected) target.innerHTML=journal(result.rows,admin,page); }
      catch(error) { if(target.isConnected) target.textContent=error.message; }
    };
    const load = async (message='') => {
      const data=await context.request('load'); if(!host.isConnected) return;
      host.innerHTML=`<p class="learning-status" role="status">${escape(message)}</p><button class="secondary learning-refresh" data-refresh-tools>Refresh tools</button>`+
        (mode==='accounts'?performance(data.snapshots)+breakdown(context.portfolio(),context.stocks()):'')+
        (!admin?alerts(data):'')+(mode==='research'?watchlist(data):'')+
        (mode!=='research'?assignments(data,admin):'')+(admin?scenarios(data):'')+
        (mode!=='research'?`<section class="card">${admin?`<label>Filter journal by student<select data-journal-student><option value="">All students</option>${context.students().map(s=>`<option value="${escape(s.id)}" ${student===s.id?'selected':''}>${escape(s.username)}</option>`).join('')}</select></label>`:''}<div data-journal></div></section>`:'');
      await renderJournal();
    };
    const status = message => { const target=host.querySelector('.learning-status'); if(target) {target.textContent=message; target.scrollIntoView?.({block:'nearest'});} };
    host.addEventListener('submit',async event=>{
      const form=event.target.closest('form[data-learning-action]'); if(!form) return;
      event.preventDefault(); const button=form.querySelector('button'); button.disabled=true;
      try {
        const body=Object.fromEntries(new FormData(form));
        if(body.ticker) body.ticker=body.ticker.trim().toUpperCase();
        for(const key of ['due_at','starts_at','ends_at']) if(body[key]) body[key]=new Date(body[key]).toISOString();
        if(form.dataset.learningAction==='scenario.create' && body.kind==='jump') body.ends_at=body.starts_at;
        if(form.dataset.learningAction==='scenario.create' && body.kind==='linear' && !body.ends_at) throw new Error('Choose a finish time for the gradual move.');
        await context.request(form.dataset.learningAction,body);
        await load('Saved.');
      } catch(error) {status(error.message);button.disabled=false;}
    });
    host.addEventListener('change',async event=>{
      if(event.target.matches('[data-journal-student]')) {student=event.target.value;page=0;await renderJournal();}
    });
    host.addEventListener('click',async event=>{
      const button=event.target.closest('button'); if(!button) return;
      try {
        if(button.hasAttribute('data-open-stock')) {await context.openStock(button.dataset.openStock);return;}
        if(button.hasAttribute('data-journal-page')) {button.disabled=true;page=Number(button.dataset.journalPage);await renderJournal();return;}
        if(button.hasAttribute('data-refresh-tools')) {button.disabled=true;await load('Updated.');return;}
        if(button.hasAttribute('data-review-assignment')) {
          button.disabled=true;
          const id=button.dataset.reviewAssignment;
          const result=await context.request('assignment.review',{id});
          const target=[...host.querySelectorAll('[data-review-container]')].find(el=>el.dataset.reviewContainer===id);
          if(target) target.innerHTML=result.rows.map(r=>`<article class="learning-item"><h4>${escape(r.username)}</h4>${r.submitted_at?`<p class="small-text">Submitted ${escape(date(r.submitted_at))}${r.reviewed_at?' · Reviewed':''}</p><p class="preserve-lines">${escape(r.response)}</p>${noteForm('assignment.feedback',id,'Teacher feedback',r.feedback,r.student_id)}`:'<p>Not submitted</p>'}</article>`).join('')||'<p>No students yet.</p>';
          button.disabled=false;return;
        }
        if(button.dataset.learningAction) {
          button.disabled=true;
          await context.request(button.dataset.learningAction,{id:button.dataset.id,ticker:button.dataset.ticker});
          await load('Updated.');
        }
      } catch(error) {status(error.message);button.disabled=false;}
    });
    try { await load(); }
    catch(error) { if(host.isConnected) {host.innerHTML=`<section class="card"><p class="learning-status" role="alert">${escape(error.message)}</p><button class="secondary" data-refresh-tools>Retry</button></section>`;} }
  }
  return { mount, allocation, performance, breakdown, journal };
})();
