import './style.css';
import { supabase } from './supabaseClient.js';

const USER_ID = '00000000-0000-0000-0000-000000000000';

// ── PIN lock ─────────────────────────────────────────────────
(function () {
  const PIN = '258654';
  const lockEl = document.getElementById('lock-screen');
  const input  = document.getElementById('lock-input');
  const errEl  = document.getElementById('lock-error');

  if (sessionStorage.getItem('unlocked') === '1') {
    lockEl.style.display = 'none';
    return;
  }

  lockEl.style.display = 'flex';
  document.querySelector('.app').style.visibility = 'hidden';

  function tryUnlock() {
    if (input.value === PIN) {
      sessionStorage.setItem('unlocked', '1');
      lockEl.style.display = 'none';
      document.querySelector('.app').style.visibility = '';
    } else {
      errEl.textContent = 'Incorrect PIN';
      input.value = '';
      setTimeout(() => { errEl.textContent = ''; }, 2000);
    }
  }

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  document.getElementById('lock-submit').addEventListener('click', tryUnlock);
})();

const DEFAULTS = {
  balance: 0,
  miscIncome: 0,
  miscExpense: 0,
  groceries: 0,
  fuel: 0,
  bills: [],
  settings: {
    wifeWeekly: 0,
    husbandPayday: 0,
    husbandInstapay: 0,
    anchorPaydayThursday: '',
  },
  incomeOverrides: {},
  paidBills: {},
  unpaidBills: {},
  billOverrides: {},
  clearedIncome: {},
};

(async function () {
  'use strict';

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  let S = await loadState();

  async function loadState() {
    try {
      const [{ data: settingsRow, error: sErr }, { data: bills, error: bErr }] = await Promise.all([
        supabase.from('settings').select('*').eq('user_id', USER_ID).maybeSingle(),
        supabase.from('bills').select('*').eq('user_id', USER_ID),
      ]);
      if (sErr) throw sErr;
      if (bErr) throw bErr;

      const s = clone(DEFAULTS);

      if (settingsRow) {
        s.settings.wifeWeekly           = Number(settingsRow.wife_weekly_income) || 0;
        s.settings.husbandPayday        = Number(settingsRow.payday_default) || 0;
        s.settings.husbandInstapay      = Number(settingsRow.instapay_default) || 0;
        s.settings.anchorPaydayThursday = settingsRow.anchor_thursday || '';
        s.balance     = Number(settingsRow.balance) || 0;
        s.miscIncome  = Number(settingsRow.misc_income) || 0;
        s.miscExpense = Number(settingsRow.misc_expense) || 0;
        s.groceries   = Number(settingsRow.groceries) || 0;
        s.fuel        = Number(settingsRow.fuel) || 0;
        s.incomeOverrides = settingsRow.income_overrides || {};
        s.paidBills       = settingsRow.paid_bills || {};
        s.unpaidBills     = settingsRow.unpaid_bills || {};
        s.billOverrides   = settingsRow.bill_overrides || {};
        s.clearedIncome   = settingsRow.cleared_income || {};
      }

      if (bills && bills.length) {
        s.bills = bills.map(b => ({
          id:        b.id,
          name:      b.name || '',
          amount:    b.amount ?? '',
          recurring: !!b.is_recurring,
          recurDay:  b.due_day || 1,
          dueDate:   b.due_date || '',
          autodraft: !!b.is_autodraft,
          category:  b.category || '',
        }));
      }

      return s;
    } catch (e) {
      console.error('loadState error:', e);
      return clone(DEFAULTS);
    }
  }

  async function save() {
    const billIds = S.bills.map(b => b.id);

    const [{ error: sErr }, { error: bErr }] = await Promise.all([
      supabase.from('settings').upsert({
        user_id:            USER_ID,
        wife_weekly_income: S.settings.wifeWeekly,
        payday_default:     S.settings.husbandPayday,
        instapay_default:   S.settings.husbandInstapay,
        anchor_thursday:    S.settings.anchorPaydayThursday,
        balance:            Number(S.balance) || 0,
        misc_income:        Number(S.miscIncome) || 0,
        misc_expense:       Number(S.miscExpense) || 0,
        groceries:          Number(S.groceries) || 0,
        fuel:               Number(S.fuel) || 0,
        income_overrides:   S.incomeOverrides,
        paid_bills:         S.paidBills,
        unpaid_bills:       S.unpaidBills,
        bill_overrides:     S.billOverrides,
        cleared_income:     S.clearedIncome,
      }),
      S.bills.length
        ? supabase.from('bills').upsert(S.bills.map(bill => ({
            id:           bill.id,
            user_id:      USER_ID,
            name:         bill.name || '',
            amount:       Number(bill.amount) || 0,
            is_recurring: !!bill.recurring,
            due_day:      bill.recurDay || 1,
            due_date:     bill.dueDate || null,
            category:     bill.category || '',
            is_autodraft: !!bill.autodraft,
          })))
        : Promise.resolve({ error: null }),
    ]);

    if (sErr) console.error('save settings error:', sErr);
    if (bErr) console.error('save bills error:', bErr);

    // Delete any bills removed from the list
    const del = billIds.length
      ? supabase.from('bills').delete().eq('user_id', USER_ID).not('id', 'in', `(${billIds.join(',')})`)
      : supabase.from('bills').delete().eq('user_id', USER_ID);
    del.then(({ error }) => { if (error) console.error('delete bills error:', error); });
  }

  function parseIso(s) { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
  function sod(d) { return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
  function addDays(d,n) { const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  function toIso(d) { return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`; }
  function p2(n) { return String(n).padStart(2,'0'); }
  function diffDays(a,b) { return Math.round((sod(b)-sod(a))/86400000); }
  function fmtLong(d) { return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}); }
  function fmtShort(d) { return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }

  function nextRecur(dom, ref) {
    const r = sod(ref||new Date());
    const a = new Date(r.getFullYear(), r.getMonth(), dom);
    return a >= r ? a : new Date(r.getFullYear(), r.getMonth()+1, dom);
  }

  function billDueDate(bill, ref) {
    if (bill.recurring) return nextRecur(bill.recurDay||1, ref||new Date());
    if (bill.dueDate)   return parseIso(bill.dueDate);
    return null;
  }

  function calendarHalf(ref) {
    const d = sod(ref || new Date());
    const y = d.getFullYear(), m = d.getMonth();
    if (d.getDate() <= 15) {
      return { start: new Date(y, m, 1), end: new Date(y, m, 15), label: 'First half' };
    } else {
      const lastDay = new Date(y, m + 1, 0).getDate();
      return { start: new Date(y, m, 16), end: new Date(y, m, lastDay), label: 'Second half' };
    }
  }

  function nextHalf(half) {
    return calendarHalf(addDays(half.end, 1));
  }

  function billsInHalf(bills, rangeStart, rangeEnd, ref) {
    const results = [];
    const rs = sod(rangeStart), re = sod(rangeEnd);
    bills.forEach(b => {
      if (b.recurring) {
        const dom = b.recurDay || 1;
        // Check each month the range touches
        const months = new Set();
        months.add(`${rs.getFullYear()}-${rs.getMonth()}`);
        months.add(`${re.getFullYear()}-${re.getMonth()}`);
        months.forEach(key => {
          const [y, m] = key.split('-').map(Number);
          const lastDay = new Date(y, m + 1, 0).getDate();
          const clampedDom = Math.min(dom, lastDay);
          const candidate = new Date(y, m, clampedDom);
          if (candidate >= rs && candidate <= re) {
            results.push({ bill: b, date: candidate });
          }
        });
      } else if (b.dueDate) {
        const d = parseIso(b.dueDate);
        if (d >= rs && d <= re) results.push({ bill: b, date: d });
      }
    });
    return results.sort((a, b) => a.date - b.date);
  }

  function husbandEvents(settings, overrides, from, to) {
    const anchor = sod(parseIso(settings.anchorPaydayThursday));
    let t = anchor;
    // Walk backward if range starts before anchor
    while (t > sod(from)) t = addDays(t,-7);
    // Then walk forward to the range start
    while (t < sod(from)) t = addDays(t,7);
    const out=[];
    while (t<=to) {
      const idx = Math.round(diffDays(anchor,t)/7);
      const kind = idx%2===0?'payday':'instapay';
      const key = toIso(t);
      let amt = kind==='payday'?Number(settings.husbandPayday)||0:Number(settings.husbandInstapay)||0;
      if (overrides[key]!=null && overrides[key]!=='') amt=Number(overrides[key]);
      out.push({date:t,key,kind,label:kind==='payday'?'Payday':'Instapay',amount:amt});
      t=addDays(t,7);
    }
    return out;
  }

  function wifeEvents(settings, from, to) {
    const out=[];
    for (let x=sod(from); x<=to; x=addDays(x,1)) {
      if (x.getDay()!==2) continue;
      out.push({date:x,key:toIso(x),kind:'wife',label:'Salary',amount:Number(settings.wifeWeekly)||0});
    }
    return out;
  }

  function allIncome(settings, overrides, from, to) {
    if (!settings.anchorPaydayThursday) return wifeEvents(settings, from, to);
    return [...wifeEvents(settings,from,to),...husbandEvents(settings,overrides,from,to)]
      .sort((a,b)=>a.date-b.date);
  }

  function money(n) {
    const x=Number(n); if(isNaN(x)) return '—';
    return new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(x);
  }

  function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

  const $  = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  function showView(name) {
    $$('.view').forEach(v=>v.classList.remove('is-active'));
    $(`#view-${name}`).classList.add('is-active');
    $$('.nav-btn').forEach(b=>b.classList.toggle('is-active',b.dataset.view===name));
  }

  function ordSuffix(n) {
    if(n>=11&&n<=13) return 'th';
    switch(n%10){case 1:return 'st';case 2:return 'nd';case 3:return 'rd';default:return 'th';}
  }

  function daySelectHtml(selected) {
    let o='<option value="">—</option>';
    for(let i=1;i<=31;i++) o+=`<option value="${i}"${selected==i?' selected':''}>${i}${ordSuffix(i)}</option>`;
    return `<select data-f="recurDay">${o}</select>`;
  }

  const CATS = [
    { key:'utilities',      label:'Utilities' },
    { key:'subscriptions',  label:'Subscriptions' },
    { key:'transportation', label:'Transportation' },
    { key:'credit',         label:'Credit Cards' },
  ];

  function categorySelectHtml(selected) {
    const opts = [['','—'],...CATS.map(c=>[c.key,c.label])];
    return `<select data-f="category">${opts.map(([v,l])=>`<option value="${v}"${selected===v?' selected':''}>${l}</option>`).join('')}</select>`;
  }

  function renderCategoryTotals() {
    const el = $('#cat-totals'); if(!el) return;
    el.innerHTML = CATS.map(c => {
      const total = S.bills.filter(b=>b.category===c.key).reduce((s,b)=>s+(Number(b.amount)||0),0);
      return `<div class="cat-total"><div class="cat-lbl">${c.label}</div><div class="cat-amt">${money(total)}</div></div>`;
    }).join('') + `<div class="cat-total" style="border-color:rgba(129,140,248,.2)"><div class="cat-lbl" style="color:var(--accent)">All Bills</div><div class="cat-amt" style="color:var(--accent)">${money(S.bills.reduce((s,b)=>s+(Number(b.amount)||0),0))}</div></div>`;
  }

  // Reusable: build a cashflow table into a tbody, returns final running balance
  // interactive=true enables paid checkboxes and amount editing on bill rows
  function buildCashflow(tbody, openBal, incEvents, billItems, today, interactive) {
    tbody.innerHTML = '';
    function makeRow(cells, cls) {
      const tr=document.createElement('tr');
      if(cls) tr.className=cls;
      tr.innerHTML=cells; return tr;
    }

    const timeline = [];
    incEvents.forEach(e=>timeline.push({date:e.date,type:'income',label:e.label,tag:e.kind,amount:e.amount,key:e.key}));
    billItems.forEach(({bill,date})=>{
      const bkey = bill.id+'-'+toIso(date);
      const overAmt = S.billOverrides[bkey];
      const baseAmt = Number(bill.amount)||0;
      const amt = (overAmt!=null && overAmt!=='') ? Number(overAmt) : baseAmt;
      timeline.push({date,type:'bill',label:bill.name||'Unnamed',autodraft:!!bill.autodraft,amount:amt,baseAmount:baseAmt,billId:bill.id,bkey,hasOverride:(overAmt!=null && overAmt!=='')});
    });
    timeline.sort((a,b)=>a.date-b.date || (a.type==='income'?-1:1));

    let running = openBal;
    timeline.forEach(item=>{
      const past = today && sod(item.date)<sod(today);
      const alpha = 'opacity:.45;';
      const adTag = item.autodraft?'<span class="tag autodraft" style="margin-left:0.3rem">auto</span>':'';

      if(item.type==='income') {
        // Past income: already in bank — show for reference only, don't move running
        // Cleared income: user marked as already in bank — same treatment as past
        const cleared = interactive && !!S.clearedIncome[item.key];
        const effectivePast = past || cleared;
        if(!effectivePast) running+=item.amount;
        const runCell = effectivePast
          ? `<td class="running" style="${alpha}color:var(--muted)">—</td>`
          : `<td class="running ${running>=0?'pos':'neg'}">${money(running)}</td>`;
        const clearedCheck = interactive && !past
          ? `<input type="checkbox" class="cleared-check" data-key="${item.key}" ${cleared?'checked':''} title="Check if this paycheck already cleared and is sitting in your bank balance" />`
          : '';
        const clearedTag = cleared
          ? '<span class="tag" style="background:rgba(129,140,248,.1);color:var(--accent);border:1px solid rgba(129,140,248,.25);margin-left:0.3rem">in bank</span>'
          : '';
        const incDim = effectivePast ? alpha : '';
        const metaText = cleared ? ' · in bank' : past ? ' · past' : '';
        tbody.appendChild(makeRow(`
          <td><div class="row-name" style="${incDim}"><span style="display:inline-flex;align-items:center">${clearedCheck}${tagHtml(item.tag)}</span> ${esc(item.label)}${clearedTag}</div>
              <div class="row-meta">${fmtLong(item.date)}${metaText}</div></td>
          <td class="amt pos" style="${incDim}">${effectivePast?'':'+'}${money(item.amount)}</td>
          ${runCell}`));
      } else {
        // Past bills: checked = cleared (already in bank balance, don't move running)
        //             unchecked = hasn't pulled yet (still in bank, WILL leave — move running)
        // Future bills: unchecked = unpaid (move running), checked = paid early (already left, don't move)
        const isChecked = past ? !S.unpaidBills[item.bkey] : !!S.paidBills[item.bkey];
        const affectsRunning = past ? !isChecked : !isChecked; // only unpaid/uncleared items move running
        if(affectsRunning) running -= item.amount;

        const dimmed = isChecked; // visually dim cleared/paid items
        const dimStyle = dimmed?'opacity:.35;':'';
        const pastClearedStyle = (past && isChecked) ? alpha : '';

        const paidCheck = interactive
          ? `<input type="checkbox" class="paid-check" data-bkey="${item.bkey}" data-past="${past?'1':'0'}" ${isChecked?'checked':''} title="${past?'Uncheck if bill hasn\'t pulled yet':'Mark as paid'}" />`
          : '';
        const overTag = item.hasOverride ? '<span class="tag" style="background:rgba(251,191,36,.1);color:var(--amber);border:1px solid rgba(251,191,36,.25);margin-left:0.3rem">adj</span>' : '';
        const statusTag = !past && isChecked
          ? '<span class="tag" style="background:rgba(52,211,153,.1);color:var(--green);border:1px solid rgba(52,211,153,.2);margin-left:0.3rem">paid</span>'
          : past && !isChecked
          ? '<span class="tag" style="background:rgba(251,191,36,.1);color:var(--amber);border:1px solid rgba(251,191,36,.25);margin-left:0.3rem">pending</span>'
          : '';

        // Running total: cleared past bills show "—", everything else shows the number
        const runCell = past && isChecked
          ? `<td class="running" style="${alpha}color:var(--muted)">—</td>`
          : `<td class="running ${running>=0?'pos':'neg'}" style="${dimStyle}">${money(running)}</td>`;

        const amtCell = interactive && affectsRunning && !past
          ? `<td class="amt neg amt-editable" data-bkey="${item.bkey}" data-base="${item.baseAmount}" style="${dimStyle}">−${money(item.amount)}</td>`
          : `<td class="amt neg" style="${past&&isChecked?alpha:dimStyle}">−${money(item.amount)}</td>`;

        const metaText = past && !isChecked ? ' · not cleared' : past ? ' · past' : isChecked ? ' · paid early' : '';
        const tr = makeRow(`
          <td><div class="flow-row-name" style="${dimStyle||pastClearedStyle}">${paidCheck}📋 ${esc(item.label)}${adTag}${overTag}${statusTag}</div>
              <div class="row-meta">${fmtLong(item.date)}${metaText}</div></td>
          ${amtCell}
          ${runCell}`,
          dimmed && !past ? 'row-paid' : '');
        tbody.appendChild(tr);
      }
    });

    return running;
  }

  function renderDashboard() {
    const today = new Date();
    const cfg   = S.settings;
    const half  = calendarHalf(today);
    const {start:from, end:to} = half;
    const nxt   = nextHalf(half);

    // Period bar
    $('#cycle-label').textContent = half.label;
    $('#cycle-range').textContent = `${fmtLong(from)} → ${fmtLong(to)}`;

    const bal       = Number(S.balance)||0;
    const miscIn    = Number(S.miscIncome)||0;
    const miscOut   = Number(S.miscExpense)||0;
    const groceries = Number(S.groceries)||0;
    const fuel      = Number(S.fuel)||0;
    const start     = bal + miscIn - miscOut - groceries - fuel;

    // Income & bills for current half
    const incEvents     = allIncome(cfg, S.incomeOverrides, from, to);
    const incTotal      = incEvents.reduce((s,e)=>s+e.amount,0);
    const curBills      = billsInHalf(S.bills, from, to, today);
    const billsTotal    = curBills.reduce((s,{bill})=>s+(Number(bill.amount)||0),0);
    const billsPast     = curBills.filter(({date})=>sod(date)<sod(today));
    const billsFuture   = curBills.filter(({date})=>sod(date)>=sod(today));

    // Unpaid bills = future bills not marked paid + past bills user unchecked (haven't pulled yet)
    const billsRemain   = curBills.reduce((s,{bill,date})=>{
      const bkey = bill.id+'-'+toIso(date);
      const past = sod(date)<sod(today);
      const overAmt = S.billOverrides[bkey];
      const amt = (overAmt!=null && overAmt!=='') ? Number(overAmt) : (Number(bill.amount)||0);
      if (past) {
        // Past bill: paid by default unless user unchecked it
        return S.unpaidBills[bkey] ? s + amt : s;
      } else {
        // Future bill: unpaid by default unless user checked it
        return S.paidBills[bkey] ? s : s + amt;
      }
    },0);

    // Future income only — past income is already in your bank balance
    // Also exclude income the user marked as already cleared (in bank) to avoid double-counting
    const incFuture     = incEvents.filter(e=>sod(e.date)>=sod(today));
    const incRemain     = incFuture.reduce((s,e)=>S.clearedIncome[e.key]?s:s+e.amount,0);

    // LIVE safe to spend = what's in the bank + income still coming - bills still owed
    const safeToSpend   = start + incRemain - billsRemain;

    $('#period-income').textContent = money(incTotal);
    $('#period-bills-total').textContent = money(billsTotal);

    // Hero: bills remaining
    const bc = $('#hero-bills-card');
    const paidEarlyCount = billsFuture.filter(({bill,date})=>S.paidBills[bill.id+'-'+toIso(date)]).length;
    const pastNotCleared = billsPast.filter(({bill,date})=>S.unpaidBills[bill.id+'-'+toIso(date)]).length;
    const totalUnpaid = (billsFuture.length - paidEarlyCount) + pastNotCleared;
    $('#hero-bills-left').textContent = money(billsRemain);
    const parts = [`${totalUnpaid} unpaid`];
    if (paidEarlyCount) parts.push(`${paidEarlyCount} paid early`);
    if (pastNotCleared) parts.push(`${pastNotCleared} pending`);
    parts.push(`${billsPast.length - pastNotCleared} cleared`);
    $('#hero-bills-sub').textContent = parts.join(' · ');
    bc.className = 'hero-card' + (billsRemain > start+incRemain*0.8 ? ' danger' : billsRemain > 500 ? ' warn' : '');

    // Hero: safe to spend
    const sc = $('#hero-safe-card');
    $('#hero-safe').textContent = money(safeToSpend);
    if (safeToSpend<=0) {
      sc.className='hero-card danger';
      $('#hero-safe-sub').textContent='Short — review income & bills';
    } else if (safeToSpend<150) {
      sc.className='hero-card warn';
      $('#hero-safe-sub').textContent='Running tight';
    } else {
      sc.className='hero-card safe';
      $('#hero-safe-sub').textContent=`${totalUnpaid} bills + ${incFuture.length} paychecks remaining`;
    }

    // Hero: paychecks pending (future uncleared income)
    const pendingInc      = incFuture.filter(e=>!S.clearedIncome[e.key]);
    const clearedIncCount = incFuture.length - pendingInc.length;
    const pendingIncTotal = pendingInc.reduce((s,e)=>s+e.amount,0);
    $('#hero-income-pending').textContent = money(pendingIncTotal);
    const incParts = [`${pendingInc.length} check${pendingInc.length!==1?'s':''} pending`];
    if (clearedIncCount) incParts.push(`${clearedIncCount} in bank`);
    $('#hero-income-sub').textContent = incParts.join(' · ');

    // ── Current half cashflow ──
    $('#flow-title').textContent = `Running cashflow — ${half.label} (${fmtShort(from)} – ${fmtShort(to)})`;
    const endingBal = buildCashflow(
      $('#flow-tbody'), start, incEvents, curBills, today, true
    );
    // End-of-half row
    const flowTbody = $('#flow-tbody');
    const endTr = document.createElement('tr');
    endTr.innerHTML = `
      <td><div class="row-name" style="font-weight:600">End of half</div>
          <div class="row-meta">${fmtLong(to)}</div></td>
      <td></td>
      <td class="running ${endingBal>=0?'pos':'neg'}" style="font-weight:600">${money(endingBal)}</td>`;
    flowTbody.appendChild(endTr);

    // ── Look-ahead: next half ──
    const nxtInc   = allIncome(cfg, S.incomeOverrides, nxt.start, nxt.end);
    const nxtBills = billsInHalf(S.bills, nxt.start, nxt.end);
    const nxtIncTotal  = nxtInc.reduce((s,e)=>s+e.amount,0);
    const nxtBillTotal = nxtBills.reduce((s,{bill})=>s+(Number(bill.amount)||0),0);

    $('#lookahead-title').textContent = `Look-ahead — ${nxt.label} (${fmtShort(nxt.start)} – ${fmtShort(nxt.end)})`;
    const nxtEnding = buildCashflow(
      $('#lookahead-tbody'), endingBal, nxtInc, nxtBills, null
    );
    // End row for look-ahead
    const laTbody = $('#lookahead-tbody');
    const laEndTr = document.createElement('tr');
    laEndTr.innerHTML = `
      <td><div class="row-name" style="font-weight:600">Net result</div>
          <div class="row-meta">income minus bills for this half</div></td>
      <td></td>
      <td class="running ${nxtEnding>=0?'pos':'neg'}" style="font-weight:600">${money(nxtEnding)}</td>`;
    laTbody.appendChild(laEndTr);

    // Seed quick-add date inputs with a sensible default date in each half
    const qaDateCur = $('#qa-date-cur');
    const qaDateNxt = $('#qa-date-nxt');
    if (qaDateCur) {
      const curDefault = sod(today) >= sod(from) && sod(today) <= sod(to) ? toIso(today) : toIso(from);
      qaDateCur.value = qaDateCur.value || curDefault;
      qaDateCur.min = toIso(from); qaDateCur.max = toIso(to);
    }
    if (qaDateNxt) {
      qaDateNxt.value = qaDateNxt.value || toIso(nxt.start);
      qaDateNxt.min = toIso(nxt.start); qaDateNxt.max = toIso(nxt.end);
    }
  }

  function tagHtml(kind) {
    if(kind==='wife')     return '<span class="tag wife">Salary</span>';
    if(kind==='payday')   return '<span class="tag payday">Payday</span>';
    return '<span class="tag instapay">Instapay</span>';
  }

  function renderBillsTable() {
    const tb=$('#bills-tbody');
    tb.innerHTML='';
    let rTotal=0, oTotal=0;

    // Sort: recurring bills by recurDay (1st first), then one-time by dueDate
    const sorted = [...S.bills].sort((a,b)=>{
      const aR=!!a.recurring, bR=!!b.recurring;
      if(aR && bR) return (a.recurDay||1)-(b.recurDay||1);
      if(aR && !bR) return -1;
      if(!aR && bR) return 1;
      return (a.dueDate||'').localeCompare(b.dueDate||'');
    });

    sorted.forEach(bill=>{
      const isR=!!bill.recurring;
      const isAD=!!bill.autodraft;
      const amt=Number(bill.amount)||0;
      if(isR) rTotal+=amt; else oTotal+=amt;

      const tr=document.createElement('tr');
      tr.dataset.id=bill.id;
      const dueCell=isR
        ? daySelectHtml(bill.recurDay||1)
        : `<input type="date" data-f="dueDate" value="${esc(bill.dueDate||'')}" />`;

      tr.innerHTML=`
        <td><input type="text"   data-f="name"   value="${esc(bill.name)}" placeholder="Bill name" /></td>
        <td><input type="number" data-f="amount" min="0" step="0.01" value="${bill.amount??''}" /></td>
        <td class="toggle-cell"><input type="checkbox" class="toggle" data-f="recurring" ${isR?'checked':''} /></td>
        <td>${dueCell}</td>
        <td class="toggle-cell"><input type="checkbox" class="toggle" data-f="autodraft" ${isAD?'checked':''} /></td>
        <td>${categorySelectHtml(bill.category||'')}</td>
        <td><button type="button" class="btn-del" data-del>Remove</button></td>`;
      tb.appendChild(tr);
    });

    $('#total-recurring').textContent=money(rTotal);
    $('#total-onetime').textContent=money(oTotal);
    $('#total-all').textContent=money(rTotal+oTotal);
    renderCategoryTotals();
  }

  function renderSchedule() {
    const cfg=S.settings;
    $('#sched-wife-line').textContent=`${money(cfg.wifeWeekly)} every Tuesday`;
    const list=$('#list-schedule');
    list.innerHTML='';
    const from=new Date(), to=addDays(from,35);
    const events = allIncome(cfg,S.incomeOverrides,from,to)
      .filter(e=>e.date>=sod(from));

    let nextInstapayKey = null;
    let nextPaydayKey = null;
    for (const e of events) {
      if (e.kind === 'instapay' && !nextInstapayKey) nextInstapayKey = e.key;
      if (e.kind === 'payday'   && !nextPaydayKey)   nextPaydayKey   = e.key;
      if (nextInstapayKey && nextPaydayKey) break;
    }

    events.forEach(e=>{
      const li=document.createElement('li');
      const isOverrideable = (e.key === nextInstapayKey || e.key === nextPaydayKey);

      if (e.kind === 'wife') {
        li.innerHTML=`
          <span class="ev-left">
            <span class="ev-labels">${tagHtml(e.kind)} <span>${esc(e.label)}</span></span>
            <span class="ev-meta">${fmtLong(e.date)}</span>
          </span>
          <span class="ev-amt">${money(e.amount)}</span>`;
      } else if (isOverrideable) {
        const defaultAmt = e.kind==='payday'
          ? Number(cfg.husbandPayday)||0
          : Number(cfg.husbandInstapay)||0;
        const hasOverride = S.incomeOverrides[e.key] != null && S.incomeOverrides[e.key] !== '';
        const overrideVal = hasOverride ? S.incomeOverrides[e.key] : '';
        const overrideCls = hasOverride ? ' is-overridden' : '';

        li.innerHTML=`
          <span class="ev-left">
            <span class="ev-labels">${tagHtml(e.kind)} <span>${esc(e.label)}</span> <span class="tag" style="background:#1a2a3a;color:var(--accent);border:1px solid var(--accent2)">next up</span></span>
            <span class="ev-meta">${fmtLong(e.date)}${hasOverride ? ' · overridden' : ' · editable'}</span>
          </span>
          <input type="number" class="override-input${overrideCls}" data-key="${e.key}"
                 placeholder="${defaultAmt}" value="${overrideVal}"
                 min="0" step="0.01"
                 title="Override amount for this week (blank = default $${defaultAmt})" />`;
      } else {
        li.innerHTML=`
          <span class="ev-left">
            <span class="ev-labels">${tagHtml(e.kind)} <span>${esc(e.label)}</span></span>
            <span class="ev-meta">${fmtLong(e.date)}</span>
          </span>
          <span class="ev-amt">${money(e.amount)}</span>`;
      }

      list.appendChild(li);
    });
  }

  function syncSettings() {
    const c=S.settings;
    $('#set-wife').value=c.wifeWeekly;
    $('#set-payday').value=c.husbandPayday;
    $('#set-instapay').value=c.husbandInstapay;
    $('#set-anchor-thu').value=c.anchorPaydayThursday;
  }

  function syncBalance() {
    $('#input-balance').value=S.balance;
    $('#input-misc-income').value=S.miscIncome;
    $('#input-misc-expense').value=S.miscExpense;
    $('#input-groceries').value=S.groceries;
    $('#input-fuel').value=S.fuel;
  }

  function refresh() { syncBalance(); syncSettings(); renderDashboard(); renderBillsTable(); renderSchedule(); }

  $$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>showView(btn.dataset.view)));

  $('#input-balance').addEventListener('input', async function() { S.balance=this.value; await save(); renderDashboard(); });
  $('#input-misc-income').addEventListener('input', async function() { S.miscIncome=this.value; await save(); renderDashboard(); });
  $('#input-misc-expense').addEventListener('input', async function() { S.miscExpense=this.value; await save(); renderDashboard(); });
  $('#input-groceries').addEventListener('input',  async function() { S.groceries=this.value; await save(); renderDashboard(); });
  $('#input-fuel').addEventListener('input',       async function() { S.fuel=this.value; await save(); renderDashboard(); });

  const smap = {
    '#set-wife':        v=>S.settings.wifeWeekly=v?Number(v):0,
    '#set-payday':      v=>S.settings.husbandPayday=v?Number(v):0,
    '#set-instapay':    v=>S.settings.husbandInstapay=v?Number(v):0,
    '#set-anchor-thu':  v=>S.settings.anchorPaydayThursday=v,
  };
  Object.entries(smap).forEach(([sel,fn])=>{
    $(sel).addEventListener('change', async ()=>{ fn($(sel).value); await save(); renderDashboard(); renderSchedule(); });
  });

  $('#list-schedule').addEventListener('change', async ev=>{
    const inp = ev.target;
    if (!(inp instanceof HTMLInputElement) || !inp.classList.contains('override-input')) return;
    const key = inp.dataset.key;
    if (inp.value === '') {
      delete S.incomeOverrides[key];
    } else {
      S.incomeOverrides[key] = inp.value;
    }
    await save();
    renderDashboard();
    renderSchedule();
  });

  // Cashflow: mark income as cleared (already in bank balance)
  $('#flow-tbody').addEventListener('change', ev=>{
    const chk = ev.target;
    if (!(chk instanceof HTMLInputElement)) return;
    if (chk.classList.contains('cleared-check')) {
      const key = chk.dataset.key;
      if (chk.checked) { S.clearedIncome[key] = true; } else { delete S.clearedIncome[key]; }
      save(); renderDashboard();
      return;
    }
  });

  // Cashflow: mark bills as paid/unpaid
  $('#flow-tbody').addEventListener('change', ev=>{
    const chk = ev.target;
    if (!(chk instanceof HTMLInputElement) || !chk.classList.contains('paid-check')) return;
    const bkey = chk.dataset.bkey;
    const isPastBill = chk.dataset.past === '1';
    if (isPastBill) {
      // Past bill: unchecking = "hasn't pulled yet", checking = default (cleared)
      if (!chk.checked) {
        S.unpaidBills[bkey] = true;
      } else {
        delete S.unpaidBills[bkey];
      }
    } else {
      // Future bill: checking = "paid early", unchecking = default (unpaid)
      if (chk.checked) {
        S.paidBills[bkey] = true;
      } else {
        delete S.paidBills[bkey];
      }
    }
    save(); renderDashboard();
  });

  // Cashflow: tap bill amount to edit
  $('#flow-tbody').addEventListener('click', ev=>{
    const td = ev.target.closest('.amt-editable');
    if (!td || td.querySelector('.bill-amt-edit')) return;
    const bkey = td.dataset.bkey;
    const baseAmt = td.dataset.base;
    const curOver = S.billOverrides[bkey];
    const curVal = (curOver!=null && curOver!=='') ? curOver : baseAmt;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'bill-amt-edit' + ((curOver!=null && curOver!=='') ? ' is-overridden' : '');
    inp.value = curVal;
    inp.min = '0';
    inp.step = '0.01';
    inp.title = `Default: $${baseAmt} — blank to reset`;
    td.textContent = '';
    td.appendChild(inp);
    inp.focus();
    inp.select();

    function commit() {
      const v = inp.value.trim();
      if (v === '' || v === baseAmt || Number(v) === Number(baseAmt)) {
        delete S.billOverrides[bkey];
      } else {
        S.billOverrides[bkey] = v;
      }
      save(); renderDashboard();
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', ev2=>{
      if (ev2.key==='Enter') { ev2.preventDefault(); inp.blur(); }
      if (ev2.key==='Escape') { delete S.billOverrides[bkey]; save(); renderDashboard(); }
    });
  });

  // Quick-add toggle / cancel / submit
  document.addEventListener('click', ev=>{
    // Toggle form open
    if (ev.target.classList.contains('qa-toggle')) {
      const form = document.getElementById(ev.target.dataset.target);
      if (!form) return;
      const isHidden = form.style.display === 'none';
      form.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) form.querySelector('.qa-inp.name')?.focus();
      return;
    }
    // Cancel form
    if (ev.target.classList.contains('qa-cancel')) {
      const form = document.getElementById(ev.target.dataset.target);
      if (form) form.style.display = 'none';
      return;
    }
    // Submit
    if (ev.target.classList.contains('qa-submit')) {
      const half = ev.target.dataset.half; // 'cur' or 'nxt'
      const name = document.getElementById(`qa-name-${half}`)?.value.trim();
      const amt  = document.getElementById(`qa-amt-${half}`)?.value.trim();
      const date = document.getElementById(`qa-date-${half}`)?.value;
      if (!name || !amt || !date) { alert('Fill in name, amount, and date.'); return; }
      S.bills.push({
        id: `bill-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        name, amount: amt, recurring: false, recurDay: 1, dueDate: date,
        autodraft: false, category: '',
      });
      save();
      // Clear form and hide
      document.getElementById(`qa-name-${half}`).value = '';
      document.getElementById(`qa-amt-${half}`).value  = '';
      document.getElementById(`qa-form-${half}`).style.display = 'none';
      renderDashboard();
      renderBillsTable();
      return;
    }
  });

  // Auto-clean old paid/override data (older than 60 days) to avoid cruft
  (function cleanOldData() {
    const cutoff = addDays(new Date(), -60);
    [S.paidBills, S.billOverrides, S.unpaidBills, S.clearedIncome].forEach(obj => {
      Object.keys(obj).forEach(key => {
        const datePart = key.split('-').slice(-3).join('-');
        try {
          const d = parseIso(datePart);
          if (d < cutoff) delete obj[key];
        } catch {}
      });
    });
  })();

  $('#btn-add-bill').addEventListener('click',()=>{
    S.bills.push({id:`bill-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:'',amount:'',recurring:false,recurDay:1,dueDate:'',autodraft:false,category:''});
    save(); renderBillsTable(); renderDashboard();
  });

  function handleBills(ev) {
    const el=ev.target; if(!el?.dataset?.f) return;
    const tr=el.closest('tr'); if(!tr) return;
    const bill=S.bills.find(b=>b.id===tr.dataset.id); if(!bill) return;
    const f=el.dataset.f;
    if(f==='name')      bill.name=el.value;
    if(f==='amount')    bill.amount=el.value;
    if(f==='dueDate')   bill.dueDate=el.value;
    if(f==='recurDay')  bill.recurDay=Number(el.value)||1;
    if(f==='category')  { bill.category=el.value; save(); renderCategoryTotals(); return; }
    if(f==='autodraft') { bill.autodraft=el.checked; save(); return; }
    if(f==='recurring') { bill.recurring=el.checked; if(el.checked) bill.dueDate=''; save(); renderBillsTable(); renderDashboard(); return; }
    save(); renderDashboard();
    const rT=S.bills.filter(b=>b.recurring).reduce((s,b)=>s+(Number(b.amount)||0),0);
    const oT=S.bills.filter(b=>!b.recurring).reduce((s,b)=>s+(Number(b.amount)||0),0);
    $('#total-recurring').textContent=money(rT);
    $('#total-onetime').textContent=money(oT);
    $('#total-all').textContent=money(rT+oT);
  }
  $('#bills-tbody').addEventListener('input', handleBills);
  $('#bills-tbody').addEventListener('change',handleBills);

  $('#bills-tbody').addEventListener('click',ev=>{
    const t=ev.target;
    if(!(t instanceof HTMLElement)||t.dataset.del==null) return;
    const tr=t.closest('tr'); if(!tr) return;
    S.bills=S.bills.filter(b=>b.id!==tr.dataset.id);
    save(); renderBillsTable(); renderDashboard();
  });

  $('#btn-export').addEventListener('click',()=>{
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(S,null,2)],{type:'application/json'}));
    a.download=`household-budget-${toIso(new Date())}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  });

  $('#input-import').addEventListener('change',ev=>{
    const f=ev.target.files?.[0]; if(!f) return;
    const r=new FileReader();
    r.onload=()=>{
      try {
        const p=JSON.parse(String(r.result));
        S={...clone(DEFAULTS),...p,settings:{...DEFAULTS.settings,...(p.settings||{})}};
        save(); refresh();
      } catch { alert('Could not import — check the file.'); }
      ev.target.value='';
    };
    r.readAsText(f);
  });

  try { refresh(); } catch(err) {
    const el=$('#boot-error');
    if(el){ el.className='boot-error visible'; el.textContent=`Failed to start: ${err?.message||String(err)}`; }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { type: 'module' }).catch(()=>{});
  }

})();
