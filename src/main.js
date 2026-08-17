import './style.css';
import { supabase } from './supabaseClient.js';

const savedTheme = localStorage.getItem('ghp-theme');
document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : 'dark';

// Tag for the shared household row. Security is enforced by Supabase RLS
// (auth.uid() allowlist), not by this constant.
const USER_ID = '00000000-0000-0000-0000-000000000000';

// ── Auth gate ────────────────────────────────────────────────
const authScreen = document.getElementById('auth-screen');
const appEl      = document.querySelector('.app');

function showAuth() {
  authScreen.style.display = 'flex';
  appEl.style.visibility   = 'hidden';
}
function hideAuth() {
  authScreen.style.display = 'none';
  appEl.style.visibility   = '';
}

async function waitForSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) { hideAuth(); return session; }

  showAuth();
  const form       = document.getElementById('auth-form');
  const emailInput = document.getElementById('auth-email');
  const pwInput    = document.getElementById('auth-password');
  const errEl      = document.getElementById('auth-error');
  const submitBtn  = document.getElementById('auth-submit');
  emailInput.focus();

  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in…';
      const { data, error } = await supabase.auth.signInWithPassword({
        email: emailInput.value.trim(),
        password: pwInput.value,
      });
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
      if (error) {
        errEl.textContent = error.message || 'Sign-in failed';
        pwInput.select();
        return;
      }
      pwInput.value = '';
      hideAuth();
      resolve(data.session);
    });
  });
}

const DEFAULTS = {
  balance: 0,
  bills: [],
  oneTimePayments: [],
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
  meals: [],   // [{ id, date (YYYY-MM-DD), name, notes }]
  lists: [],   // [{ id, title, notes, createdAt, updatedAt }]
  listItems: [], // [{ id, listId, text, completed, sortOrder, createdAt, updatedAt }]
};

(async function () {
  'use strict';

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  const session = await waitForSession();

  let S = await loadState();

  async function loadState() {
    try {
      const [
        { data: settingsRow, error: sErr },
        { data: bills,       error: bErr },
        { data: meals,       error: mErr },
        { data: payments,    error: pErr },
        { data: lists,       error: lErr },
        { data: listItems,   error: liErr },
      ] = await Promise.all([
        supabase.from('settings').select('*').eq('user_id', USER_ID).maybeSingle(),
        supabase.from('bills').select('*').eq('user_id', USER_ID),
        supabase.from('meals').select('*').eq('user_id', USER_ID),
        supabase.from('one_time_payments').select('*').eq('user_id', USER_ID),
        supabase.from('shared_lists').select('*').eq('user_id', USER_ID),
        supabase.from('shared_list_items').select('*').eq('user_id', USER_ID),
      ]);
      if (sErr) throw sErr;
      if (bErr) throw bErr;
      if (mErr) throw mErr;
      if (pErr) throw pErr;
      if (lErr) throw lErr;
      if (liErr) throw liErr;

      const s = clone(DEFAULTS);

      if (settingsRow) {
        s.settings.wifeWeekly           = Number(settingsRow.wife_weekly_income) || 0;
        s.settings.husbandPayday        = Number(settingsRow.payday_default) || 0;
        s.settings.husbandInstapay      = Number(settingsRow.instapay_default) || 0;
        s.settings.anchorPaydayThursday = settingsRow.anchor_thursday || '';
        s.balance     = Number(settingsRow.balance) || 0;
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
          recurKind: b.recur_kind || 'monthly', // 'monthly' or 'weekly'
          recurDay:  b.due_day ?? 1,            // DOM (1-31) or DOW (0-6); ?? preserves Sunday=0
          dueDate:   b.due_date || '',
          autodraft: !!b.is_autodraft,
          category:  b.category || '',
        }));
      }

      if (meals && meals.length) {
        s.meals = meals.map(m => ({
          id:    m.id,
          date:  m.meal_date,
          name:  m.name || '',
          notes: m.notes || '',
        }));
      }

      if (payments && payments.length) {
        s.oneTimePayments = payments.map(payment => ({
          id:          payment.id,
          name:        payment.name || '',
          amount:      payment.amount ?? '',
          paymentDate: payment.payment_date || '',
        }));
      }

      if (lists && lists.length) {
        s.lists = lists.map(list => ({
          id:        list.id,
          title:     list.title || '',
          notes:     list.notes || '',
          createdAt: list.created_at || '',
          updatedAt: list.updated_at || list.created_at || '',
        }));
      }

      if (listItems && listItems.length) {
        s.listItems = listItems.map(item => ({
          id:        item.id,
          listId:    item.list_id,
          text:      item.item_text || '',
          completed: !!item.is_completed,
          sortOrder: Number(item.sort_order) || 0,
          createdAt: item.created_at || '',
          updatedAt: item.updated_at || item.created_at || '',
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
    const paymentIds = S.oneTimePayments.map(payment => payment.id);

    const [{ error: sErr }, { error: bErr }, { error: pErr }] = await Promise.all([
      supabase.from('settings').upsert({
        user_id:            USER_ID,
        wife_weekly_income: S.settings.wifeWeekly,
        payday_default:     S.settings.husbandPayday,
        instapay_default:   S.settings.husbandInstapay,
        anchor_thursday:    S.settings.anchorPaydayThursday,
        balance:            Number(S.balance) || 0,
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
            recur_kind:   bill.recurKind || 'monthly',
            due_day:      Number(bill.recurDay ?? 1),
            due_date:     bill.dueDate || null,
            category:     bill.category || '',
            is_autodraft: !!bill.autodraft,
          })))
        : Promise.resolve({ error: null }),
      S.oneTimePayments.length
        ? supabase.from('one_time_payments').upsert(S.oneTimePayments.map(payment => ({
            id:           payment.id,
            user_id:      USER_ID,
            name:         payment.name || '',
            amount:       Number(payment.amount) || 0,
            payment_date: payment.paymentDate,
          })))
        : Promise.resolve({ error: null }),
    ]);

    if (sErr) console.error('save settings error:', sErr);
    if (bErr) console.error('save bills error:', bErr);
    if (pErr) console.error('save one-time payments error:', pErr);

    // Delete any bills removed from the list
    const del = billIds.length
      ? supabase.from('bills').delete().eq('user_id', USER_ID).not('id', 'in', `(${billIds.join(',')})`)
      : supabase.from('bills').delete().eq('user_id', USER_ID);
    del.then(({ error }) => { if (error) console.error('delete bills error:', error); });

    const paymentDel = paymentIds.length
      ? supabase.from('one_time_payments').delete().eq('user_id', USER_ID).not('id', 'in', `(${paymentIds.join(',')})`)
      : supabase.from('one_time_payments').delete().eq('user_id', USER_ID);
    paymentDel.then(({ error }) => { if (error) console.error('delete one-time payments error:', error); });
  }

  // ── Meals & shared-list targeted save helpers ──────────────
  async function saveMealRow(meal) {
    const { error } = await supabase.from('meals').upsert({
      id:        meal.id,
      user_id:   USER_ID,
      meal_date: meal.date,
      name:      meal.name || '',
      notes:     meal.notes || '',
    });
    if (error) console.error('saveMealRow error:', error);
  }
  async function deleteMealRow(id) {
    const { error } = await supabase.from('meals').delete().eq('id', id);
    if (error) console.error('deleteMealRow error:', error);
  }
  async function saveListRow(list) {
    const now = new Date().toISOString();
    list.updatedAt = now;
    const { error } = await supabase.from('shared_lists').upsert({
      id:         list.id,
      user_id:    USER_ID,
      title:      list.title || '',
      notes:      list.notes || '',
      created_at: list.createdAt || now,
      updated_at: now,
    });
    if (error) console.error('saveListRow error:', error);
    return !error;
  }
  async function deleteListRow(id) {
    const { error } = await supabase.from('shared_lists').delete().eq('id', id);
    if (error) console.error('deleteListRow error:', error);
  }
  async function saveListItemRow(item) {
    const now = new Date().toISOString();
    item.updatedAt = now;
    const { error } = await supabase.from('shared_list_items').upsert({
      id:           item.id,
      list_id:      item.listId,
      user_id:      USER_ID,
      item_text:    item.text || '',
      is_completed: !!item.completed,
      sort_order:   Number(item.sortOrder) || 0,
      created_at:   item.createdAt || now,
      updated_at:   now,
    });
    if (error) console.error('saveListItemRow error:', error);
    return !error;
  }
  async function deleteListItemRow(id) {
    const { error } = await supabase.from('shared_list_items').delete().eq('id', id);
    if (error) console.error('deleteListItemRow error:', error);
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
      if (b.recurring && b.recurKind === 'weekly') {
        // Weekly: emit one instance per matching DOW in [rs, re]
        const targetDow = Math.max(0, Math.min(6, Number(b.recurDay) || 0));
        // Find first occurrence >= rs
        let cursor = new Date(rs);
        while (cursor.getDay() !== targetDow) cursor = addDays(cursor, 1);
        while (cursor <= re) {
          results.push({ bill: b, date: new Date(cursor) });
          cursor = addDays(cursor, 7);
        }
      } else if (b.recurring) {
        // Monthly: existing logic — check months at the range boundaries
        const dom = b.recurDay || 1;
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
      const baseAmount = kind==='payday'?Number(settings.husbandPayday)||0:Number(settings.husbandInstapay)||0;
      let amt = baseAmount;
      if (overrides[key]!=null && overrides[key]!=='') amt=Number(overrides[key]);
      out.push({date:t,key,kind,label:kind==='payday'?'Payday':'Instapay',amount:amt,baseAmount,hasOverride:(overrides[key]!=null && overrides[key]!=='')});
      t=addDays(t,7);
    }
    return out;
  }

  function wifeEvents(settings, overrides, from, to) {
    const out=[];
    for (let x=sod(from); x<=to; x=addDays(x,1)) {
      if (x.getDay()!==2) continue;
      const key = toIso(x);
      const baseAmount = Number(settings.wifeWeekly)||0;
      const hasOverride = overrides[key]!=null && overrides[key]!=='';
      const amount = hasOverride ? Number(overrides[key]) : baseAmount;
      out.push({date:x,key,kind:'wife',label:'Salary',amount,baseAmount,hasOverride});
    }
    return out;
  }

  function oneTimePaymentEvents(payments, from, to) {
    const rangeStart = sod(from);
    const rangeEnd = sod(to);
    return payments
      .filter(payment => payment.paymentDate)
      .map(payment => ({
        date:      parseIso(payment.paymentDate),
        key:       `payment-${payment.id}-${payment.paymentDate}`,
        kind:      'payment',
        label:     payment.name || 'One-time payment',
        amount:    Number(payment.amount) || 0,
        paymentId: payment.id,
      }))
      .filter(payment => payment.date >= rangeStart && payment.date <= rangeEnd);
  }

  function allIncome(settings, overrides, payments, from, to) {
    const scheduled = settings.anchorPaydayThursday
      ? [...wifeEvents(settings,overrides,from,to), ...husbandEvents(settings,overrides,from,to)]
      : wifeEvents(settings, overrides, from, to);
    return [...scheduled, ...oneTimePaymentEvents(payments, from, to)]
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

  function showSubView(name) {
    $$('.sub-view').forEach(v=>v.classList.remove('is-active'));
    $(`#sub-${name}`).classList.add('is-active');
    $$('.sub-nav-btn').forEach(b=>b.classList.toggle('is-active',b.dataset.subview===name));
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

  function dowSelectHtml(selected) {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const safe = (Number(selected) >= 0 && Number(selected) <= 6) ? Number(selected) : 1;
    let o = '';
    for (let i = 0; i < 7; i++) {
      o += `<option value="${i}"${safe===i?' selected':''}>${days[i]}</option>`;
    }
    return `<select data-f="recurDay">${o}</select>`;
  }

  function recurrenceCellHtml(bill) {
    if (!bill.recurring) {
      return `<input type="date" data-f="dueDate" value="${esc(bill.dueDate||'')}" />`;
    }
    const kind = bill.recurKind || 'monthly';
    const dayPicker = kind === 'weekly'
      ? dowSelectHtml(bill.recurDay)
      : daySelectHtml(bill.recurDay || 1);
    return `
      <select data-f="recurKind" style="margin-bottom:0.25rem;display:block;width:100%">
        <option value="monthly" ${kind==='monthly'?'selected':''}>Monthly</option>
        <option value="weekly"  ${kind==='weekly' ?'selected':''}>Weekly</option>
      </select>
      ${dayPicker}
    `;
  }

  const CATS = [
    { key:'utilities',      label:'Utilities' },
    { key:'subscriptions',  label:'Subscriptions' },
    { key:'transportation', label:'Home & Auto' },     // key kept for backwards compat
    { key:'food_grocery',   label:'Food & Grocery' },
    { key:'credit',         label:'Credit Cards' },
  ];

  function categorySelectHtml(selected) {
    const opts = [['','—'],...CATS.map(c=>[c.key,c.label])];
    return `<select data-f="category">${opts.map(([v,l])=>`<option value="${v}"${selected===v?' selected':''}>${l}</option>`).join('')}</select>`;
  }

  // Convert any bill to its monthly-equivalent amount.
  // Weekly bills × 4.33 (avg weeks/month). Monthly + one-time bills as-is.
  const WEEKS_PER_MONTH = 52 / 12; // 4.3333...
  function billMonthlyEquivalent(bill) {
    const amt = Number(bill.amount) || 0;
    if (bill.recurring && bill.recurKind === 'weekly') return amt * WEEKS_PER_MONTH;
    return amt;
  }

  function renderCategoryTotals() {
    const el = $('#cat-totals'); if(!el) return;
    el.innerHTML = CATS.map(c => {
      const total = S.bills
        .filter(b => b.category === c.key)
        .reduce((s,b) => s + billMonthlyEquivalent(b), 0);
      return `<div class="cat-total"><div class="cat-lbl">${c.label}</div><div class="cat-amt">${money(total)}</div></div>`;
    }).join('') + `<div class="cat-total" style="border-color:rgba(91,141,239,.2)"><div class="cat-lbl" style="color:var(--accent)">All Bills</div><div class="cat-amt" style="color:var(--accent)">${money(S.bills.reduce((s,b) => s + billMonthlyEquivalent(b), 0))}</div></div>`;
  }

  // Reusable: build a cashflow table into a tbody, returns final running balance
  // interactive=true enables cleared/paid controls and occurrence-level amount editing.
  function buildCashflow(tbody, openBal, incEvents, billItems, today, interactive) {
    tbody.innerHTML = '';
    function makeRow(cells, cls) {
      const tr=document.createElement('tr');
      if(cls) tr.className=cls;
      tr.innerHTML=cells; return tr;
    }

    const timeline = [];
    incEvents.forEach(e=>timeline.push({
      date:e.date,
      type:'income',
      label:e.label,
      tag:e.kind,
      amount:e.amount,
      baseAmount:e.baseAmount,
      hasOverride:!!e.hasOverride,
      key:e.key,
      paymentId:e.paymentId,
    }));
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
      const adTag = item.autodraft?'<span class="tag autodraft" title="Autodraft" style="margin-left:0.3rem">A</span>':'';

      if(item.type==='income') {
        const cleared = interactive && !!S.clearedIncome[item.key];
        const effectivePast = past || cleared;
        if(!effectivePast) running+=item.amount;
        const runCell = effectivePast
          ? `<td class="running" style="${alpha}color:var(--muted)">—</td>`
          : `<td class="running ${running>=0?'pos':'neg'}">${money(running)}</td>`;
        const clearedCheck = interactive && !past
          ? `<input type="checkbox" class="cleared-check" data-key="${item.key}" ${cleared?'checked':''} title="Check if this income item already cleared and is sitting in your bank balance" />`
          : '';
        const clearedTag = cleared
          ? '<span class="tag" title="Already in bank balance" style="background:rgba(91,141,239,.1);color:var(--accent);border:1px solid rgba(91,141,239,.25);margin-left:0.3rem">✓</span>'
          : '';
        const incDim = effectivePast ? alpha : '';
        const metaText = cleared ? ' · in bank' : past ? ' · past' : '';
        const paymentLabel = item.paymentId ? ` <span class="flow-income-label">${esc(item.label)}</span>` : '';
        const overTag = item.hasOverride ? '<span class="tag" title="Adjusted from default" style="background:rgba(245,158,11,.1);color:var(--amber);border:1px solid rgba(245,158,11,.25);margin-left:0.3rem">±</span>' : '';
        const removeButton = item.paymentId
          ? `<button type="button" class="flow-remove" data-payment-id="${esc(item.paymentId)}" title="Remove this one-time payment">Remove</button>`
          : '';
        const amountCell = interactive && !past && !item.paymentId
          ? `<td class="amt pos income-amt-editable" data-key="${item.key}" data-base="${item.baseAmount}" style="${incDim}" title="Tap to adjust only this income occurrence">+${money(item.amount)}</td>`
          : `<td class="amt pos" style="${incDim}">${effectivePast?'':'+'}${money(item.amount)}</td>`;
        tbody.appendChild(makeRow(`
          <td><div class="row-name" style="${incDim}"><span style="display:inline-flex;align-items:center">${clearedCheck}${tagHtml(item.tag)}</span>${paymentLabel}${overTag}${clearedTag}${removeButton}</div>
              <div class="row-meta">${fmtLong(item.date)}${metaText}</div></td>
          ${amountCell}
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
        const overTag = item.hasOverride ? '<span class="tag" title="Adjusted from default" style="background:rgba(245,158,11,.1);color:var(--amber);border:1px solid rgba(245,158,11,.25);margin-left:0.3rem">±</span>' : '';
        const statusTag = !past && isChecked
          ? '<span class="tag" title="Paid" style="background:rgba(74,222,128,.1);color:var(--green);border:1px solid rgba(74,222,128,.2);margin-left:0.3rem">✓</span>'
          : past && !isChecked
          ? '<span class="tag" title="Pending — bill has not pulled yet" style="background:rgba(245,158,11,.1);color:var(--amber);border:1px solid rgba(245,158,11,.25);margin-left:0.3rem">P</span>'
          : '';

        // Running total: cleared past bills show "—", everything else shows the number
        const runCell = past && isChecked
          ? `<td class="running" style="${alpha}color:var(--muted)">—</td>`
          : `<td class="running ${running>=0?'pos':'neg'}" style="${dimStyle}">${money(running)}</td>`;

        const amtCell = interactive && !past
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

  // ── Week helpers ────────────────────────────────────────────
  // Mon-anchored week. Returns { start: Mon, end: Sun }
  function weekRange(ref, weekOffset = 0) {
    const d = sod(ref || new Date());
    const dow = d.getDay(); // 0=Sun..6=Sat
    // Days back to Monday: Sun(0)→6, Mon(1)→0, Tue(2)→1, ... Sat(6)→5
    const daysBackToMon = (dow + 6) % 7;
    const monday = addDays(d, -daysBackToMon + weekOffset * 7);
    const sunday = addDays(monday, 6);
    return { start: monday, end: sunday };
  }

  let mealsWeekOffset = 0; // 0 = current week, 1 = next week
  let selectedListId = null;

  const NEVADA_TIMEZONE = 'America/Chicago';
  const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=37.83808&longitude=-94.35931&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=1';

  function syncThemeButton() {
    const light = document.documentElement.dataset.theme === 'light';
    const icon = document.getElementById('theme-toggle-icon');
    const label = document.getElementById('theme-toggle-label');
    if (icon) icon.textContent = light ? '☀' : '☾';
    if (label) label.textContent = light ? 'Light' : 'Dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#e7e5e8' : '#08080b');
  }

  function updateAmbientClock() {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: NEVADA_TIMEZONE,
    }).format(now));
    const greeting = hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.';
    const greetingEl = document.getElementById('home-greeting');
    if (greetingEl) greetingEl.textContent = greeting;
    const dateEl = document.getElementById('ambient-date');
    if (dateEl) dateEl.textContent = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: NEVADA_TIMEZONE,
    }).format(now);
    const timeEl = document.getElementById('ambient-time');
    if (timeEl) timeEl.textContent = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: NEVADA_TIMEZONE,
    }).format(now);
  }

  function weatherDescription(code) {
    if (code === 0) return 'Clear';
    if (code <= 3) return 'Partly cloudy';
    if (code === 45 || code === 48) return 'Foggy';
    if (code >= 51 && code <= 57) return 'Drizzle';
    if (code >= 61 && code <= 67) return 'Rain';
    if (code >= 71 && code <= 77) return 'Snow';
    if (code >= 80 && code <= 82) return 'Showers';
    if (code >= 85 && code <= 86) return 'Snow showers';
    if (code >= 95) return 'Thunderstorms';
    return 'Mixed conditions';
  }

  function weatherIcon(code, isDay) {
    if (code === 0) return isDay ? '☀' : '☾';
    if (code <= 3) return isDay ? '◒' : '☁';
    if (code === 45 || code === 48) return '≋';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '☂';
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '❄';
    if (code >= 95) return 'ϟ';
    return '◌';
  }

  async function loadWeather() {
    try {
      const response = await fetch(WEATHER_URL);
      if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
      const data = await response.json();
      const current = data.current || {};
      const daily = data.daily || {};
      const code = Number(current.weather_code) || 0;
      document.getElementById('weather-icon').textContent = weatherIcon(code, !!current.is_day);
      document.getElementById('weather-temp').textContent = `${Math.round(Number(current.temperature_2m))}°`;
      document.getElementById('weather-desc').textContent = weatherDescription(code);
      const high = Math.round(Number(daily.temperature_2m_max?.[0]));
      const low = Math.round(Number(daily.temperature_2m_min?.[0]));
      const rain = Math.round(Number(daily.precipitation_probability_max?.[0]) || 0);
      const wind = Math.round(Number(current.wind_speed_10m) || 0);
      document.getElementById('weather-meta').textContent = `Nevada, MO · H ${high}° / L ${low}° · ${rain}% rain · ${wind} mph`;
    } catch (error) {
      console.warn('Weather unavailable:', error);
      document.getElementById('weather-desc').textContent = 'Weather unavailable';
      document.getElementById('weather-meta').textContent = 'Nevada, Missouri · time is still live';
    }
  }

  // Walk the timeline (same logic as buildCashflow) up to and including
  // targetDate, returning the running balance at that point + the lowest
  // running balance encountered (for negative-flag warnings).
  function runningBalanceAt(targetDate) {
    const today = new Date();
    const cfg   = S.settings;
    const start = Number(S.balance) || 0;

    // Window: from start of current half through targetDate (extending into
    // next half if targetDate falls past current half's end).
    const half = calendarHalf(today);
    const periodStart = half.start;
    const periodEnd   = sod(targetDate) > sod(half.end) ? targetDate : half.end;

    const incEvents = allIncome(cfg, S.incomeOverrides, S.oneTimePayments, periodStart, periodEnd);
    const bills     = billsInHalf(S.bills, periodStart, periodEnd, today);

    const timeline = [];
    incEvents.forEach(e => timeline.push({date: e.date, type: 'income', amount: e.amount, key: e.key}));
    bills.forEach(({bill, date}) => {
      const bkey = bill.id + '-' + toIso(date);
      const overAmt = S.billOverrides[bkey];
      const baseAmt = Number(bill.amount)||0;
      const amt = (overAmt!=null && overAmt!=='') ? Number(overAmt) : baseAmt;
      timeline.push({date, type: 'bill', amount: amt, bkey});
    });
    timeline.sort((a,b) => a.date - b.date || (a.type === 'income' ? -1 : 1));

    let running = start;
    let minRunning = start;
    let minDate = today;

    for (const item of timeline) {
      if (sod(item.date) > sod(targetDate)) break;
      const past = sod(item.date) < sod(today);
      if (item.type === 'income') {
        const cleared = !!S.clearedIncome[item.key];
        // Past or cleared income is already in bank balance; only future uncleared
        // income moves the running total.
        if (!past && !cleared) running += item.amount;
      } else {
        const isChecked = past ? !S.unpaidBills[item.bkey] : !!S.paidBills[item.bkey];
        if (!isChecked) running -= item.amount;
      }
      if (running < minRunning) {
        minRunning = running;
        minDate = item.date;
      }
    }

    return { running, minRunning, minDate };
  }

  function renderToday() {
    const todayIso = toIso(new Date());
    const meal = S.meals.find(m => m.date === todayIso);
    const dateLabel = fmtLong(new Date());
    const todayMoney = runningBalanceAt(new Date()).running;
    const openItems = S.listItems.filter(item => !item.completed).length;

    const mealLine = meal && meal.name
      ? `<div class="today-focus"><span class="today-lbl">Dinner</span><strong>${esc(meal.name)}</strong>${meal.notes ? `<span class="today-meta">${esc(meal.notes)}</span>` : ''}</div>`
      : `<div class="today-focus"><span class="today-lbl">Dinner</span><span class="today-empty">No meal planned yet</span></div>`;

    document.getElementById('today-title').textContent = `Today · ${dateLabel}`;
    document.getElementById('today-content').innerHTML =
      `<div class="today-stack">${mealLine}
        <div class="today-metrics">
          <div><span>Available</span><strong>${money(todayMoney)}</strong></div>
          <div><span>Open list items</span><strong>${openItems}</strong></div>
        </div>
      </div>`;
  }

  function renderSnapshots() {
    const today = new Date();
    const sevenOut = addDays(today, 7);

    // "Available now" = running balance at end of today (matches the cashflow
    // chart at today's row).
    const now  = runningBalanceAt(today);
    // "Available 7 days out" = projected running balance one week from today.
    const next = runningBalanceAt(sevenOut);

    document.getElementById('snapshot-now').textContent = money(now.running);
    document.getElementById('snapshot-now-sub').innerHTML =
      `<div>As of today:</div><div>${fmtLong(today)}</div>`;
    const nowCard = document.getElementById('snapshot-now-card');
    nowCard.classList.remove('safe','warn','danger');
    nowCard.classList.add(now.running <= 0 ? 'danger' : now.running < 200 ? 'warn' : 'safe');

    document.getElementById('snapshot-next-label').textContent = 'Seven days out';
    document.getElementById('snapshot-next').textContent = money(next.running);

    const dippedNegative = next.minRunning < 0;
    const nextSub = dippedNegative
      ? `<div>⚠ Dips to ${money(next.minRunning)}</div><div>on ${fmtShort(next.minDate)}</div>`
      : `<div>Projected by:</div><div>${fmtLong(sevenOut)}</div>`;
    document.getElementById('snapshot-next-sub').innerHTML = nextSub;
    const nextCard = document.getElementById('snapshot-next-card');
    nextCard.classList.remove('safe','warn','danger');
    nextCard.classList.add(dippedNegative || next.running <= 0 ? 'danger' : next.running < 200 ? 'warn' : 'safe');
  }

  function compactMoney(value) {
    const amount = Math.abs(Number(value) || 0);
    const sign = Number(value) < 0 ? '−' : '';
    if (amount >= 1000) return `${sign}$${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}k`;
    return `${sign}$${Math.round(amount)}`;
  }

  function renderCashflowChart() {
    const host = document.getElementById('cashflow-chart');
    if (!host) return;
    const today = sod(new Date());
    const series = Array.from({ length: 14 }, (_, index) => {
      const date = addDays(today, index);
      return { date, value: runningBalanceAt(date).running };
    });
    const values = series.map(point => point.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const rawSpan = Math.max(max - min, 100);
    min -= rawSpan * 0.14;
    max += rawSpan * 0.14;

    const width = 760, height = 258;
    const pad = { top: 20, right: 18, bottom: 42, left: 54 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = index => pad.left + (index / (series.length - 1)) * plotW;
    const y = value => pad.top + ((max - value) / (max - min || 1)) * plotH;
    const line = series.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
    const area = `M ${x(0).toFixed(1)} ${(pad.top + plotH).toFixed(1)} ${line.replace(/^M/, 'L')} L ${x(series.length - 1).toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;
    const grid = Array.from({ length: 4 }, (_, index) => {
      const ratio = index / 3;
      const value = max - ratio * (max - min);
      const py = pad.top + ratio * plotH;
      return `<line x1="${pad.left}" y1="${py}" x2="${width - pad.right}" y2="${py}" class="chart-grid-line" />
        <text x="${pad.left - 9}" y="${py + 4}" text-anchor="end" class="chart-y-label">${compactMoney(value)}</text>`;
    }).join('');
    const labels = series.map((point, index) => index % 2 === 0 || index === series.length - 1
      ? `<text x="${x(index)}" y="${height - 13}" text-anchor="middle" class="chart-x-label">${point.date.toLocaleDateString(undefined,{weekday:'short'})} ${point.date.getDate()}</text>`
      : '').join('');
    const dots = series.map((point, index) => `<circle cx="${x(index)}" cy="${y(point.value)}" r="${index === 0 || index === 7 || index === 13 ? 4.5 : 2.5}" class="chart-dot${point.value < 0 ? ' is-negative' : ''}"><title>${fmtLong(point.date)}: ${money(point.value)}</title></circle>`).join('');
    const dividerX = x(7) - (plotW / 26);

    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Projected balance for the next fourteen days">
      <defs>
        <linearGradient id="cashflow-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity=".28" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      <line x1="${dividerX}" y1="${pad.top}" x2="${dividerX}" y2="${pad.top + plotH}" class="chart-week-divider" />
      <text x="${dividerX + 8}" y="${pad.top + 12}" class="chart-week-label">NEXT WEEK</text>
      <path d="${area}" class="chart-area" />
      <path d="${line}" class="chart-line" />
      ${dots}
      ${labels}
    </svg>
    <div class="chart-caption"><span>Today ${money(series[0].value)}</span><span>14-day outlook ${money(series[13].value)}</span></div>`;
  }

  function renderMealsStrip() {
    const { start, end } = weekRange(new Date(), mealsWeekOffset);
    const todayIso = toIso(new Date());
    document.getElementById('meals-title').innerHTML =
      mealsWeekOffset === 0
        ? `<span>Dinner menu</span><span class="card-subtitle">This week · ${fmtShort(start)} – ${fmtShort(end)}</span>`
        : `<span>Dinner menu</span><span class="card-subtitle">Next week · ${fmtShort(start)} – ${fmtShort(end)}</span>`;

    const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const iso = toIso(d);
      const meal = S.meals.find(m => m.date === iso);
      const isToday = iso === todayIso;
      const cellCls = isToday ? 'meal-cell is-today' : 'meal-cell';
      cells.push(`
        <div class="${cellCls}">
          <div class="meal-day">${dayLabels[i]}</div>
          <div class="meal-date">${d.getMonth()+1}/${d.getDate()}</div>
          <textarea class="meal-name-input" data-date="${iso}" rows="1" placeholder="—"
            enterkeyhint="enter" spellcheck="false">${esc(meal?.name || '')}</textarea>
        </div>
      `);
    }
    const stripEl = document.getElementById('meals-strip');
    stripEl.innerHTML = cells.join('');
    // Auto-size each textarea to its content on initial render
    stripEl.querySelectorAll('.meal-name-input').forEach(autoResizeTextarea);
  }

  function autoResizeTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight) + 'px';
  }

  function listItemsFor(listId) {
    return S.listItems
      .filter(item => item.listId === listId)
      .sort((a, b) => a.sortOrder - b.sortOrder || String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function renderListLibrary() {
    const host = document.getElementById('saved-lists');
    const lists = [...S.lists].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!lists.length) {
      host.innerHTML = '<div class="saved-lists-empty">No lists yet.<br>Create one for groceries, errands, or anything else.</div>';
      return;
    }
    host.innerHTML = lists.map(list => {
      const items = listItemsFor(list.id);
      const done = items.filter(item => item.completed).length;
      const percent = items.length ? Math.round(done / items.length * 100) : 0;
      return `<button type="button" class="saved-list-card${list.id === selectedListId ? ' is-active' : ''}" data-list-id="${esc(list.id)}">
        <span class="saved-list-glyph">${percent === 100 && items.length ? '✓' : '□'}</span>
        <span class="saved-list-copy"><strong>${esc(list.title)}</strong><small>${done} of ${items.length} complete</small></span>
        <span class="saved-list-arrow">›</span>
      </button>`;
    }).join('');
  }

  function renderListEditor() {
    const empty = document.getElementById('list-editor-empty');
    const editor = document.getElementById('list-editor');
    const list = S.lists.find(item => item.id === selectedListId);
    if (!list) {
      empty.hidden = false;
      editor.hidden = true;
      return;
    }

    empty.hidden = true;
    editor.hidden = false;
    document.getElementById('list-title-edit').value = list.title;
    document.getElementById('list-notes-edit').value = list.notes || '';
    const items = listItemsFor(list.id);
    const done = items.filter(item => item.completed).length;
    document.getElementById('list-progress').textContent = `${done} of ${items.length} complete`;
    const itemsHost = document.getElementById('list-items');
    itemsHost.innerHTML = items.length ? items.map(item => `
      <li class="list-item-row${item.completed ? ' is-complete' : ''}" data-item-id="${esc(item.id)}">
        <label class="list-check-wrap" title="${item.completed ? 'Mark as not done' : 'Mark as complete'}">
          <input type="checkbox" class="list-item-check" data-item-id="${esc(item.id)}" ${item.completed ? 'checked' : ''} />
          <span class="list-check-ui"></span>
        </label>
        <input type="text" class="list-item-text" data-item-id="${esc(item.id)}" value="${esc(item.text)}" maxlength="160" aria-label="List item" />
        <button type="button" class="list-item-remove" data-item-id="${esc(item.id)}" aria-label="Remove ${esc(item.text)}">×</button>
      </li>
    `).join('') : '<li class="list-items-empty">Nothing here yet. Add the first line below.</li>';
  }

  function renderLists() {
    if (selectedListId && !S.lists.some(list => list.id === selectedListId)) selectedListId = null;
    if (!selectedListId && S.lists.length) {
      selectedListId = [...S.lists].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0].id;
    }
    renderListLibrary();
    renderListEditor();
  }

  function renderWeek() {
    updateAmbientClock();
    renderToday();
    renderSnapshots();
    renderCashflowChart();
    renderMealsStrip();
    renderLists();
  }

  function billOccurrenceAmount(bill, date) {
    const bkey = `${bill.id}-${toIso(date)}`;
    const override = S.billOverrides[bkey];
    return (override != null && override !== '') ? Number(override) : Number(bill.amount) || 0;
  }

  function renderUpcomingBillsSummary(curBills, nxtBills, today, currentEnd) {
    const host = document.getElementById('upcoming-bills-summary');
    if (!host) return;
    const firstUpcoming = bills => bills
      .filter(({ date }) => sod(date) >= sod(today))
      .sort((a, b) => a.date - b.date);
    const currentUpcoming = firstUpcoming(curBills).slice(0, 4);
    const nextUpcoming = firstUpcoming(nxtBills).slice(0, 3);
    const upcoming = [...currentUpcoming, ...nextUpcoming];

    if (!upcoming.length) {
      host.innerHTML = '<div class="upcoming-empty">Nothing else is due through the next half.</div>';
      return;
    }

    host.innerHTML = upcoming.map(({ bill, date }) => {
      const bkey = `${bill.id}-${toIso(date)}`;
      const paid = !!S.paidBills[bkey];
      const amount = billOccurrenceAmount(bill, date);
      const baseAmount = Number(bill.amount) || 0;
      const adjusted = S.billOverrides[bkey] != null && S.billOverrides[bkey] !== '';
      const halfLabel = sod(date) <= sod(currentEnd) ? 'This half' : 'Next half';
      return `<div class="upcoming-bill-row${paid ? ' is-paid' : ''}" data-bkey="${esc(bkey)}">
        <label class="upcoming-check" title="${paid ? 'Mark unpaid' : 'Mark paid early'}">
          <input type="checkbox" class="overview-paid-check" data-bkey="${esc(bkey)}" ${paid ? 'checked' : ''} />
          <span></span>
        </label>
        <div class="upcoming-bill-copy">
          <strong>${esc(bill.name || 'Unnamed bill')}</strong>
          <small>${fmtShort(date)} · ${halfLabel}${bill.autodraft ? ' · Autodraft' : ''}${adjusted ? ' · Adjusted' : ''}</small>
        </div>
        <label class="upcoming-amount">
          <span>$</span>
          <input type="number" class="overview-amount-input${adjusted ? ' is-overridden' : ''}" data-bkey="${esc(bkey)}" data-base="${baseAmount}" min="0" step="0.01" value="${amount}" aria-label="Amount for ${esc(bill.name || 'bill')} on ${fmtShort(date)}" />
        </label>
      </div>`;
    }).join('');
  }

  function renderDashboard() {
    // Keep the Week-view snapshot card in sync — every budget-side change
    // (balance, paid bills, income overrides, etc.) flows through here.
    renderSnapshots();
    renderCashflowChart();

    const today = new Date();
    const cfg   = S.settings;
    const half  = calendarHalf(today);
    const {start:from, end:to} = half;
    const nxt   = nextHalf(half);

    // Period bar
    $('#cycle-label').textContent = half.label;
    $('#cycle-range').textContent = `${fmtLong(from)} → ${fmtLong(to)}`;

    const start = Number(S.balance) || 0;

    // Income & bills for current half
    const incEvents     = allIncome(cfg, S.incomeOverrides, S.oneTimePayments, from, to);
    const incTotal      = incEvents.reduce((s,e)=>s+e.amount,0);
    const curBills      = billsInHalf(S.bills, from, to, today);
    const billsTotal    = curBills.reduce((s,{bill,date})=>s+billOccurrenceAmount(bill,date),0);
    const billsPast     = curBills.filter(({date})=>sod(date)<sod(today));
    const billsFuture   = curBills.filter(({date})=>sod(date)>=sod(today));
    const nxtInc        = allIncome(cfg, S.incomeOverrides, S.oneTimePayments, nxt.start, nxt.end);
    const nxtBills      = billsInHalf(S.bills, nxt.start, nxt.end);

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

    // Uncommitted = what's in the bank + income still coming - bills still owed.
    const uncommitted   = start + incRemain - billsRemain;

    $('#period-income').textContent = money(incTotal);
    $('#period-bills-total').textContent = money(billsTotal);

    // Helper: render a list of bullet lines into a sub-text element.
    const renderBullets = (id, lines) =>
      $(`#${id}`).innerHTML = lines.map(l => `<div>• ${l}</div>`).join('');

    // Hero: bills remaining
    const bc = $('#hero-bills-card');
    const paidEarlyCount = billsFuture.filter(({bill,date})=>S.paidBills[bill.id+'-'+toIso(date)]).length;
    const pastNotCleared = billsPast.filter(({bill,date})=>S.unpaidBills[bill.id+'-'+toIso(date)]).length;
    const totalUnpaid = (billsFuture.length - paidEarlyCount) + pastNotCleared;
    $('#hero-bills-left').textContent = money(billsRemain);
    const billsLines = [
      `${totalUnpaid} unpaid`,
      `${pastNotCleared} pending`,
      `${billsPast.length - pastNotCleared} cleared`,
    ];
    if (paidEarlyCount) billsLines.push(`${paidEarlyCount} paid early`);
    renderBullets('hero-bills-sub', billsLines);
    bc.classList.remove('safe', 'warn', 'danger');
    bc.classList.add(billsRemain > start + incRemain * 0.8 ? 'danger' : billsRemain > 500 ? 'warn' : 'safe');

    const committedPercent = incTotal > 0 ? Math.min(100, Math.max(0, billsTotal / incTotal * 100)) : (billsTotal ? 100 : 0);
    const ring = $('#budget-ring');
    ring.style.setProperty('--ring-fill', `${committedPercent * 3.6}deg`);
    ring.classList.toggle('is-over', billsTotal > incTotal && incTotal > 0);

    // Hero: uncommitted cash (same dip-flag logic the Home page uses).
    const sc = $('#hero-safe-card');
    const snap = runningBalanceAt(to);
    const dippedNegative = snap.minRunning < 0;
    $('#hero-safe').textContent = money(uncommitted);
    sc.classList.remove('safe', 'warn', 'danger');
    if (dippedNegative) {
      sc.classList.add('danger');
      renderBullets('hero-safe-sub', [
        `⚠ Dips to ${money(snap.minRunning)}`,
        `on ${fmtShort(snap.minDate)}`,
      ]);
    } else if (uncommitted <= 0) {
      sc.classList.add('danger');
      renderBullets('hero-safe-sub', ['Short — review income & bills']);
    } else if (uncommitted < 150) {
      sc.classList.add('warn');
      renderBullets('hero-safe-sub', ['Running tight']);
    } else {
      sc.classList.add('safe');
      renderBullets('hero-safe-sub', [
        `${totalUnpaid} bills remaining`,
        `${incFuture.length} income items remaining`,
      ]);
    }

    // Hero: pending future income
    const pendingInc      = incFuture.filter(e=>!S.clearedIncome[e.key]);
    const clearedIncCount = incFuture.length - pendingInc.length;
    const pendingIncTotal = pendingInc.reduce((s,e)=>s+e.amount,0);
    $('#hero-income-pending').textContent = money(pendingIncTotal);
    const incLines = [`${pendingInc.length} item${pendingInc.length!==1?'s':''} pending`];
    if (clearedIncCount) incLines.push(`${clearedIncCount} in bank`);
    renderBullets('hero-income-sub', incLines);

    const incomeReceivedPercent = incTotal > 0 ? Math.max(0, Math.min(100, (incTotal - pendingIncTotal) / incTotal * 100)) : 0;
    const billsClearedPercent = billsTotal > 0 ? Math.max(0, Math.min(100, (billsTotal - billsRemain) / billsTotal * 100)) : 100;
    $('#budget-income-bar').style.width = `${incomeReceivedPercent}%`;
    $('#budget-bills-bar').style.width = `${billsClearedPercent}%`;
    const status = $('#budget-status');
    status.textContent = dippedNegative || uncommitted < 0 ? 'Needs attention' : uncommitted < 200 ? 'Running tight' : 'On track';
    status.className = `finance-status ${dippedNegative || uncommitted < 0 ? 'danger' : uncommitted < 200 ? 'warn' : 'safe'}`;

    renderUpcomingBillsSummary(curBills, nxtBills, today, to);

    // ── Current half cashflow ──
    $('#flow-title').innerHTML =
      `<span>Running cashflow</span><span class="card-subtitle">▸ ${half.label} (${fmtShort(from)} – ${fmtShort(to)})</span>`;
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
    const nxtIncTotal  = nxtInc.reduce((s,e)=>s+e.amount,0);
    const nxtBillTotal = nxtBills.reduce((s,{bill,date})=>s+billOccurrenceAmount(bill,date),0);

    $('#lookahead-title').innerHTML =
      `<span>Next half · editable</span><span class="card-subtitle">${nxt.label} (${fmtShort(nxt.start)} – ${fmtShort(nxt.end)}) · check paid early or tap an amount</span>`;
    const nxtEnding = buildCashflow(
      $('#lookahead-tbody'), endingBal, nxtInc, nxtBills, today, true
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
    const paymentDateCur = $('#payment-date-cur');
    const paymentDateNxt = $('#payment-date-nxt');
    if (qaDateCur) {
      const curDefault = sod(today) >= sod(from) && sod(today) <= sod(to) ? toIso(today) : toIso(from);
      qaDateCur.value = qaDateCur.value || curDefault;
      qaDateCur.min = toIso(from); qaDateCur.max = toIso(to);
      paymentDateCur.value = paymentDateCur.value || curDefault;
      paymentDateCur.min = toIso(from); paymentDateCur.max = toIso(to);
    }
    if (qaDateNxt) {
      qaDateNxt.value = qaDateNxt.value || toIso(nxt.start);
      qaDateNxt.min = toIso(nxt.start); qaDateNxt.max = toIso(nxt.end);
      paymentDateNxt.value = paymentDateNxt.value || toIso(nxt.start);
      paymentDateNxt.min = toIso(nxt.start); paymentDateNxt.max = toIso(nxt.end);
    }
  }

  function tagHtml(kind) {
    if(kind==='wife')     return '<span class="tag wife">Salary</span>';
    if(kind==='payday')   return '<span class="tag payday">Payday</span>';
    if(kind==='payment')  return '<span class="tag payment">One-time</span>';
    return '<span class="tag instapay">Instapay</span>';
  }

  function renderBillsTable() {
    const tb=$('#bills-tbody');
    tb.innerHTML='';
    let rMonthly=0, rWeekly=0, oTotal=0;

    // Sort: weekly recurring first (by DOW), then monthly recurring (by DOM),
    // then one-time bills (by dueDate).
    const recurRank = b => {
      if (!b.recurring) return 2;
      return (b.recurKind === 'weekly') ? 0 : 1;
    };
    const sorted = [...S.bills].sort((a,b)=>{
      const ra = recurRank(a), rb = recurRank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0 || ra === 1) return (a.recurDay||0) - (b.recurDay||0);
      return (a.dueDate||'').localeCompare(b.dueDate||'');
    });

    sorted.forEach(bill=>{
      const isR=!!bill.recurring;
      const isAD=!!bill.autodraft;
      const amt=Number(bill.amount)||0;
      // For monthly-equivalent totals, weekly bills × 4.33
      if (isR && bill.recurKind === 'weekly') rWeekly += amt * WEEKS_PER_MONTH;
      else if (isR)                           rMonthly += amt;
      else                                    oTotal += amt;

      const tr=document.createElement('tr');
      tr.dataset.id=bill.id;
      tr.innerHTML=`
        <td><input type="text"   data-f="name"   value="${esc(bill.name)}" placeholder="Bill name" /></td>
        <td><input type="number" data-f="amount" min="0" step="0.01" value="${bill.amount??''}" /></td>
        <td class="toggle-cell"><input type="checkbox" class="toggle" data-f="recurring" ${isR?'checked':''} /></td>
        <td>${recurrenceCellHtml(bill)}</td>
        <td class="toggle-cell"><input type="checkbox" class="toggle" data-f="autodraft" ${isAD?'checked':''} /></td>
        <td>${categorySelectHtml(bill.category||'')}</td>
        <td><button type="button" class="btn-del" data-del>Remove</button></td>`;
      tb.appendChild(tr);
    });

    // Render the merged Monthly totals card. Weekly bills are already
    // multiplied by 4.33 in rWeekly above so all totals are monthly-comparable.
    $('#total-monthly').textContent = money(rMonthly);
    $('#total-weekly').textContent  = money(rWeekly);
    $('#total-onetime').textContent = money(oTotal);
    $('#total-all').textContent     = money(rMonthly + rWeekly + oTotal);
    renderCategoryTotals();
  }

  function renderSchedule() {
    const cfg=S.settings;
    $('#sched-wife-line').textContent=`${money(cfg.wifeWeekly)} every Tuesday`;
    const list=$('#list-schedule');
    list.innerHTML='';
    const from=new Date(), to=addDays(from,35);
    const events = allIncome(cfg,S.incomeOverrides,S.oneTimePayments,from,to)
      .filter(e=>e.date>=sod(from));

    events.forEach(e=>{
      const li=document.createElement('li');
      const adjustedTag = e.hasOverride
        ? '<span class="tag" title="Adjusted from default" style="background:rgba(245,158,11,.1);color:var(--amber);border:1px solid rgba(245,158,11,.25)">± adjusted</span>'
        : '';
      const adjustedMeta = e.hasOverride ? ' · adjusted in cashflow' : '';

      if (e.kind === 'payment') {
        li.innerHTML=`
          <span class="ev-left">
            <span class="ev-labels">${tagHtml(e.kind)} ${esc(e.label)}</span>
            <span class="ev-meta">${fmtLong(e.date)}</span>
          </span>
          <span class="ev-amt">${money(e.amount)}</span>`;
      } else {
        li.innerHTML=`
          <span class="ev-left">
            <span class="ev-labels">${tagHtml(e.kind)} ${adjustedTag}</span>
            <span class="ev-meta">${fmtLong(e.date)}${adjustedMeta}</span>
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
  }

  function syncBalance() {
    $('#input-balance').value=S.balance;
  }

  function refresh() { syncBalance(); syncSettings(); renderWeek(); renderDashboard(); renderBillsTable(); renderSchedule(); }

  $$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>showView(btn.dataset.view)));
  $$('.sub-nav-btn').forEach(btn=>btn.addEventListener('click',()=>showSubView(btn.dataset.subview)));

  // ── Week view interactions ───────────────────────────────────
  // Toggle this week / next week for meals
  document.querySelectorAll('.meals-week-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      mealsWeekOffset = btn.dataset.week === 'nxt' ? 1 : 0;
      document.querySelectorAll('.meals-week-btn').forEach(b => b.classList.toggle('is-active', b === btn));
      renderMealsStrip();
    });
  });

  // Meal cell: commit on blur, auto-grow on input. Enter inserts a newline.
  const stripEl = document.getElementById('meals-strip');

  stripEl.addEventListener('focusout', async (ev) => {
    const inp = ev.target;
    if (!(inp instanceof HTMLTextAreaElement) || !inp.classList.contains('meal-name-input')) return;
    const date = inp.dataset.date;
    const newName = inp.value.trim();
    const existing = S.meals.find(m => m.date === date);

    if (!newName) {
      if (existing) {
        S.meals = S.meals.filter(m => m.id !== existing.id);
        await deleteMealRow(existing.id);
        renderToday();
      }
      return;
    }

    if (existing) {
      if (existing.name === newName) return;
      existing.name = newName;
      await saveMealRow(existing);
    } else {
      const meal = {
        id: `meal-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        date, name: newName, notes: '',
      };
      S.meals.push(meal);
      await saveMealRow(meal);
    }
    renderToday();
  });

  stripEl.addEventListener('input', (ev) => {
    if (ev.target.classList.contains('meal-name-input')) autoResizeTextarea(ev.target);
  });

  // ── Shared lists ──────────────────────────────────────────────
  const newListForm = document.getElementById('new-list-form');
  const newListTitle = document.getElementById('new-list-title');
  const newListNotes = document.getElementById('new-list-notes');
  const draftListItemsHost = document.getElementById('draft-list-items');
  const draftListItemInput = document.getElementById('draft-list-item-new');
  let draftListItems = [];

  function renderDraftListItems() {
    draftListItemsHost.innerHTML = draftListItems.length
      ? draftListItems.map((item, index) => `
          <li class="draft-list-row" data-draft-index="${index}">
            <span class="draft-list-dot">•</span>
            <input type="text" class="draft-list-item-text" data-draft-index="${index}" value="${esc(item)}" maxlength="160" aria-label="Draft list item" />
            <button type="button" class="draft-list-item-remove" data-draft-index="${index}" aria-label="Remove ${esc(item)}">×</button>
          </li>`).join('')
      : '<li class="list-items-empty">Add as many starter items as you need. Nothing is saved yet.</li>';
  }

  function closeNewListForm() {
    newListForm.hidden = true;
    newListTitle.value = '';
    newListNotes.value = '';
    draftListItemInput.value = '';
    draftListItems = [];
    renderDraftListItems();
  }

  document.getElementById('new-list-toggle').addEventListener('click', () => {
    newListForm.hidden = false;
    renderDraftListItems();
    newListTitle.focus();
  });
  document.getElementById('new-list-cancel').addEventListener('click', closeNewListForm);

  function addDraftListItem() {
    const text = draftListItemInput.value.trim();
    if (!text) { draftListItemInput.focus(); return; }
    draftListItems.push(text);
    draftListItemInput.value = '';
    renderDraftListItems();
    draftListItemInput.focus();
  }

  document.getElementById('draft-list-item-add').addEventListener('click', addDraftListItem);
  draftListItemInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); addDraftListItem(); }
  });

  draftListItemsHost.addEventListener('focusout', ev => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('draft-list-item-text')) return;
    const index = Number(input.dataset.draftIndex);
    const text = input.value.trim();
    if (!Number.isInteger(index) || !draftListItems[index]) return;
    if (!text) { renderDraftListItems(); return; }
    draftListItems[index] = text;
  });

  draftListItemsHost.addEventListener('keydown', ev => {
    if (!ev.target.classList.contains('draft-list-item-text')) return;
    if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); }
    if (ev.key === 'Escape') renderDraftListItems();
  });

  draftListItemsHost.addEventListener('click', ev => {
    const removeButton = ev.target.closest('.draft-list-item-remove');
    if (!removeButton) return;
    const index = Number(removeButton.dataset.draftIndex);
    if (!Number.isInteger(index)) return;
    draftListItems.splice(index, 1);
    renderDraftListItems();
  });

  async function saveDraftList() {
    const title = newListTitle.value.trim();
    if (!title) { newListTitle.focus(); return; }
    const now = new Date().toISOString();
    const list = {
      id: `list-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      notes: newListNotes.value.trim(),
      createdAt: now,
      updatedAt: now,
    };
    const items = draftListItems.map((text, index) => ({
      id: `list-item-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      listId: list.id,
      text,
      completed: false,
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
    }));

    const saveButton = document.getElementById('new-list-create');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const listSaved = await saveListRow(list);
      if (!listSaved) throw new Error('The list could not be saved.');
      const itemResults = await Promise.all(items.map(saveListItemRow));
      if (itemResults.some(saved => !saved)) {
        await deleteListRow(list.id);
        throw new Error('One or more list items could not be saved.');
      }

      S.lists.push(list);
      S.listItems.push(...items);
      selectedListId = list.id;
      closeNewListForm();
      renderLists();
      renderToday();
    } catch (error) {
      console.error('saveDraftList error:', error);
      alert('This list did not save. Please try again.');
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save to deck';
    }
  }

  document.getElementById('new-list-create').addEventListener('click', saveDraftList);
  newListTitle.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); draftListItemInput.focus(); }
    if (ev.key === 'Escape') closeNewListForm();
  });
  renderDraftListItems();

  document.getElementById('saved-lists').addEventListener('click', ev => {
    const card = ev.target.closest('.saved-list-card');
    if (!card) return;
    selectedListId = card.dataset.listId;
    renderLists();
  });

  document.getElementById('list-save-meta').addEventListener('click', async () => {
    const list = S.lists.find(item => item.id === selectedListId);
    if (!list) return;
    const titleInput = document.getElementById('list-title-edit');
    const title = titleInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    list.title = title;
    list.notes = document.getElementById('list-notes-edit').value.trim();
    await saveListRow(list);
    renderLists();
  });

  document.getElementById('list-delete').addEventListener('click', async () => {
    const list = S.lists.find(item => item.id === selectedListId);
    if (!list || !confirm(`Delete “${list.title}” and every item inside it?`)) return;
    const id = list.id;
    S.lists = S.lists.filter(item => item.id !== id);
    S.listItems = S.listItems.filter(item => item.listId !== id);
    selectedListId = null;
    await deleteListRow(id);
    renderLists();
    renderToday();
  });

  async function addListItem() {
    const list = S.lists.find(item => item.id === selectedListId);
    const input = document.getElementById('list-item-new');
    const itemText = input.value.trim();
    if (!list || !itemText) { input.focus(); return; }
    const siblings = listItemsFor(list.id);
    const now = new Date().toISOString();
    const item = {
      id: `list-item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      listId: list.id,
      text: itemText,
      completed: false,
      sortOrder: siblings.length ? Math.max(...siblings.map(entry => entry.sortOrder)) + 1 : 0,
      createdAt: now,
      updatedAt: now,
    };
    S.listItems.push(item);
    await saveListItemRow(item);
    input.value = '';
    renderLists();
    renderToday();
    document.getElementById('list-item-new').focus();
  }

  document.getElementById('list-item-add').addEventListener('click', addListItem);
  document.getElementById('list-item-new').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); addListItem(); }
  });

  const listItemsHost = document.getElementById('list-items');
  listItemsHost.addEventListener('change', async ev => {
    const checkbox = ev.target;
    if (!(checkbox instanceof HTMLInputElement) || !checkbox.classList.contains('list-item-check')) return;
    const item = S.listItems.find(entry => entry.id === checkbox.dataset.itemId);
    if (!item) return;
    item.completed = checkbox.checked;
    await saveListItemRow(item);
    renderLists();
    renderToday();
  });

  listItemsHost.addEventListener('focusout', async ev => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('list-item-text')) return;
    const item = S.listItems.find(entry => entry.id === input.dataset.itemId);
    if (!item) return;
    const value = input.value.trim();
    if (!value) { input.value = item.text; return; }
    if (value === item.text) return;
    item.text = value;
    await saveListItemRow(item);
    renderListLibrary();
  });

  listItemsHost.addEventListener('keydown', ev => {
    if (!ev.target.classList.contains('list-item-text')) return;
    if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); }
    if (ev.key === 'Escape') renderListEditor();
  });

  listItemsHost.addEventListener('click', async ev => {
    const removeButton = ev.target.closest('.list-item-remove');
    if (!removeButton) return;
    const id = removeButton.dataset.itemId;
    S.listItems = S.listItems.filter(item => item.id !== id);
    await deleteListItemRow(id);
    renderLists();
    renderToday();
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('ghp-theme', next);
    syncThemeButton();
  });

  $('#input-balance').addEventListener('input', async function() { S.balance=this.value; await save(); renderDashboard(); });

  const smap = {
    '#set-wife':        v=>S.settings.wifeWeekly=v?Number(v):0,
    '#set-payday':      v=>S.settings.husbandPayday=v?Number(v):0,
    '#set-instapay':    v=>S.settings.husbandInstapay=v?Number(v):0,
  };
  Object.entries(smap).forEach(([sel,fn])=>{
    $(sel).addEventListener('change', async ()=>{ fn($(sel).value); await save(); renderDashboard(); renderSchedule(); });
  });

  // Cashflow: mark income as cleared or bills as paid/unpaid in either half.
  function handleCashflowChange(ev) {
    const chk = ev.target;
    if (!(chk instanceof HTMLInputElement)) return;
    if (chk.classList.contains('cleared-check')) {
      const key = chk.dataset.key;
      if (chk.checked) { S.clearedIncome[key] = true; } else { delete S.clearedIncome[key]; }
      save(); renderDashboard();
      return;
    }
    if (chk.classList.contains('paid-check')) {
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
    }
  }
  [$('#flow-tbody'), $('#lookahead-tbody')].forEach(tbody => tbody.addEventListener('change', handleCashflowChange));

  // Cashflow: tap a scheduled income or bill amount to edit only that occurrence.
  function handleCashflowAmountClick(ev) {
    const td = ev.target.closest('.amt-editable, .income-amt-editable');
    if (!td || td.querySelector('.bill-amt-edit')) return;
    const isIncome = td.classList.contains('income-amt-editable');
    const occurrenceKey = isIncome ? td.dataset.key : td.dataset.bkey;
    const overrides = isIncome ? S.incomeOverrides : S.billOverrides;
    const baseAmt = td.dataset.base;
    const curOver = overrides[occurrenceKey];
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

    let handled = false;
    function commit() {
      if (handled) return;
      handled = true;
      const v = inp.value.trim();
      if (v === '' || v === baseAmt || Number(v) === Number(baseAmt)) {
        delete overrides[occurrenceKey];
      } else {
        overrides[occurrenceKey] = v;
      }
      save(); renderDashboard();
      if (isIncome) renderSchedule();
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', ev2=>{
      if (ev2.key==='Enter') { ev2.preventDefault(); inp.blur(); }
      if (ev2.key==='Escape') {
        handled = true;
        if (curOver!=null && curOver!=='') overrides[occurrenceKey] = curOver;
        else delete overrides[occurrenceKey];
        renderDashboard();
        if (isIncome) renderSchedule();
      }
    });
  }
  [$('#flow-tbody'), $('#lookahead-tbody')].forEach(tbody => tbody.addEventListener('click', handleCashflowAmountClick));

  // The visual upcoming-bills card exposes the same saved controls directly.
  const upcomingBillsHost = $('#upcoming-bills-summary');
  upcomingBillsHost.addEventListener('change', ev => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.classList.contains('overview-paid-check')) {
      const bkey = target.dataset.bkey;
      if (target.checked) S.paidBills[bkey] = true;
      else delete S.paidBills[bkey];
      save(); renderDashboard();
    }
  });
  upcomingBillsHost.addEventListener('focusout', ev => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('overview-amount-input')) return;
    const bkey = target.dataset.bkey;
    const base = Number(target.dataset.base) || 0;
    const value = target.value.trim();
    if (value === '' || Number(value) === base) delete S.billOverrides[bkey];
    else S.billOverrides[bkey] = value;
    save(); renderDashboard();
  });
  upcomingBillsHost.addEventListener('keydown', ev => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('overview-amount-input')) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      target.blur();
    }
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
        name, amount: amt, recurring: false, recurKind: 'monthly', recurDay: 1, dueDate: date,
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

    if (ev.target.classList.contains('payment-submit')) {
      const half = ev.target.dataset.half;
      const name = document.getElementById(`payment-name-${half}`)?.value.trim();
      const amt  = document.getElementById(`payment-amt-${half}`)?.value.trim();
      const date = document.getElementById(`payment-date-${half}`)?.value;
      if (!name || !amt || !date) { alert('Fill in name, amount, and date.'); return; }
      S.oneTimePayments.push({
        id: `payment-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        name,
        amount: amt,
        paymentDate: date,
      });
      save();
      document.getElementById(`payment-name-${half}`).value = '';
      document.getElementById(`payment-amt-${half}`).value = '';
      document.getElementById(`payment-form-${half}`).style.display = 'none';
      renderDashboard();
      renderSchedule();
      return;
    }

    const removePaymentButton = ev.target.closest('.flow-remove');
    if (removePaymentButton) {
      const paymentId = removePaymentButton.dataset.paymentId;
      S.oneTimePayments = S.oneTimePayments.filter(payment => payment.id !== paymentId);
      Object.keys(S.clearedIncome).forEach(key => {
        if (key.startsWith(`payment-${paymentId}-`)) delete S.clearedIncome[key];
      });
      save();
      renderDashboard();
      renderSchedule();
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
    S.bills.push({id:`bill-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:'',amount:'',recurring:false,recurKind:'monthly',recurDay:1,dueDate:'',autodraft:false,category:''});
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
    if(f==='recurDay')  bill.recurDay=Number(el.value)||0;
    if(f==='category')  { bill.category=el.value; save(); renderCategoryTotals(); return; }
    if(f==='autodraft') { bill.autodraft=el.checked; save(); return; }
    if(f==='recurring') {
      bill.recurring=el.checked;
      if(el.checked) {
        bill.dueDate='';
        if (!bill.recurKind) bill.recurKind = 'monthly';
      }
      save(); renderBillsTable(); renderDashboard(); return;
    }
    if(f==='recurKind') {
      bill.recurKind = el.value;
      // Reset day to a sensible default when the cadence changes
      if (el.value === 'weekly' && (bill.recurDay > 6 || bill.recurDay < 0)) bill.recurDay = 1;
      if (el.value === 'monthly' && (bill.recurDay < 1 || bill.recurDay > 31)) bill.recurDay = 1;
      save(); renderBillsTable(); renderDashboard(); return;
    }
    save(); renderDashboard();
    // Recompute monthly totals (weekly bills × 4.33). Updates the merged
    // Monthly totals card without re-rendering the bills table (preserves focus).
    const rMonthly = S.bills.filter(b => b.recurring && b.recurKind !== 'weekly').reduce((s,b) => s + (Number(b.amount)||0), 0);
    const rWeekly  = S.bills.filter(b => b.recurring && b.recurKind === 'weekly').reduce((s,b) => s + (Number(b.amount)||0) * WEEKS_PER_MONTH, 0);
    const oT       = S.bills.filter(b => !b.recurring).reduce((s,b) => s + (Number(b.amount)||0), 0);
    $('#total-monthly').textContent = money(rMonthly);
    $('#total-weekly').textContent  = money(rWeekly);
    $('#total-onetime').textContent = money(oT);
    $('#total-all').textContent     = money(rMonthly + rWeekly + oT);
    renderCategoryTotals();
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

  // Account: show email, sign out
  const acctEmail = $('#account-email');
  if (acctEmail) acctEmail.textContent = session?.user?.email ? `Signed in as ${session.user.email}` : '—';
  $('#btn-signout')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });

  // If the session is invalidated elsewhere (e.g. token expiry), reload to re-auth
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.reload();
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

  syncThemeButton();
  updateAmbientClock();
  loadWeather();
  setInterval(updateAmbientClock, 30000);

  try { refresh(); } catch(err) {
    const el=$('#boot-error');
    if(el){ el.className='boot-error visible'; el.textContent=`Failed to start: ${err?.message||String(err)}`; }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/budgetapp/sw.js', { type: 'module' }).catch(()=>{});
  }



})();
