import './style.css';
import { supabase } from './supabaseClient.js';
import {
  SCHEDULE_SUPERSEDED_CATEGORY,
  addIsoDays,
  billScheduleGuardIdentities,
  calendarMonthRange,
  currentCashPosition,
  forecastTimeline,
  isoDateInTimeZone,
  materializeSchedule,
  nextCycleHeadsUp,
  paydayCycleFor,
  summarizeCalendarMonth,
} from './financeEngine.js';
import {
  deleteOccurrence as deleteOccurrenceRepository,
  loadFinanceLedger,
  materializeOccurrences as materializeOccurrencesRepository,
  patchOccurrence as patchOccurrenceRepository,
  reloadOccurrences,
  saveBalanceSnapshot as saveBalanceSnapshotRepository,
  saveIncomeSourceDefault as saveIncomeSourceDefaultRepository,
  saveOccurrence as saveOccurrenceRepository,
  saveReserveFloor as saveReserveFloorRepository,
  skipFutureSourceOccurrences as skipFutureSourceOccurrencesRepository,
  updateFutureSourceAmounts as updateFutureSourceAmountsRepository,
} from './financeRepository.js';

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
    reserveFloor: 200,
  },
  incomeOverrides: {},
  paidBills: {},
  unpaidBills: {},
  billOverrides: {},
  clearedIncome: {},
  meals: [],   // [{ id, date (YYYY-MM-DD), name, notes }]
  lists: [],   // [{ id, title, notes, createdAt, updatedAt }]
  listItems: [], // [{ id, listId, text, completed, sortOrder, createdAt, updatedAt }]
  finance: {
    available: false,
    issue: null,
    household: null,
    incomeSources: [],
    occurrences: [],
    balanceSnapshot: null,
  },
};

(async function () {
  'use strict';

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  const session = await waitForSession();

  let S = await loadState();
  let financeMutationCount = 0;

  async function withFinanceMutation(operation) {
    financeMutationCount += 1;
    try {
      return await operation();
    } finally {
      financeMutationCount = Math.max(0, financeMutationCount - 1);
      if (financeMutationCount === 0) queueMicrotask(flushDeferredFinanceReload);
    }
  }

  const materializeOccurrences = (...args) => withFinanceMutation(
    () => materializeOccurrencesRepository(...args),
  );
  const deleteOccurrence = (...args) => withFinanceMutation(
    () => deleteOccurrenceRepository(...args),
  );
  const patchOccurrence = (...args) => withFinanceMutation(
    () => patchOccurrenceRepository(...args),
  );
  const saveBalanceSnapshot = (...args) => withFinanceMutation(
    () => saveBalanceSnapshotRepository(...args),
  );
  const saveIncomeSourceDefault = (...args) => withFinanceMutation(
    () => saveIncomeSourceDefaultRepository(...args),
  );
  const saveOccurrence = (...args) => withFinanceMutation(
    () => saveOccurrenceRepository(...args),
  );
  const saveReserveFloor = (...args) => withFinanceMutation(
    () => saveReserveFloorRepository(...args),
  );
  const skipFutureSourceOccurrences = (...args) => withFinanceMutation(
    () => skipFutureSourceOccurrencesRepository(...args),
  );
  const updateFutureSourceAmounts = (...args) => withFinanceMutation(
    () => updateFutureSourceAmountsRepository(...args),
  );

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
        s.settings.reserveFloor         = Number(settingsRow.reserve_floor ?? 200) || 0;
        s.balance     = Number(settingsRow.balance) || 0;
        s.incomeOverrides = settingsRow.income_overrides || {};
        s.paidBills       = settingsRow.paid_bills || {};
        s.unpaidBills     = settingsRow.unpaid_bills || {};
        s.billOverrides   = settingsRow.bill_overrides || {};
        s.clearedIncome   = settingsRow.cleared_income || {};
      }

      if (bills && bills.length) {
        s.bills = bills.filter(b => !b.archived_at).map(b => ({
          id:        b.id,
          name:      b.name || '',
          amount:    b.amount ?? '',
          recurring: !!b.is_recurring,
          recurKind: b.recur_kind || 'monthly', // 'monthly' or 'weekly'
          recurDay:  b.due_day ?? 1,            // DOM (1-31) or DOW (0-6); ?? preserves Sunday=0
          dueDate:   b.due_date || '',
          autodraft: !!b.is_autodraft,
          category:  b.category || '',
          archivedAt: b.archived_at || null,
        }));
      }

      if (meals && meals.length) {
        s.meals = meals.filter(m => !m.deleted_at).map(m => ({
          id:    m.id,
          date:  m.meal_date,
          name:  m.name || '',
          notes: m.notes || '',
        }));
      }

      if (payments && payments.length) {
        s.oneTimePayments = payments.filter(payment => !payment.archived_at).map(payment => ({
          id:          payment.id,
          name:        payment.name || '',
          amount:      payment.amount ?? '',
          paymentDate: payment.payment_date || '',
        }));
      }

      if (lists && lists.length) {
        s.lists = lists.filter(list => !list.archived_at).map(list => ({
          id:        list.id,
          title:     list.title || '',
          notes:     list.notes || '',
          createdAt: list.created_at || '',
          updatedAt: list.updated_at || list.created_at || '',
        }));
      }

      if (listItems && listItems.length) {
        const activeListIds = new Set(s.lists.map(list => list.id));
        s.listItems = listItems
          .filter(item => !item.deleted_at && activeListIds.has(item.list_id))
          .map(item => ({
            id:        item.id,
            listId:    item.list_id,
            text:      item.item_text || '',
            completed: !!item.is_completed,
            sortOrder: Number(item.sort_order) || 0,
            createdAt: item.created_at || '',
            updatedAt: item.updated_at || item.created_at || '',
          }));
      }

      try {
        s.finance = await loadFinanceLedger(supabase);
        if (s.finance.available) {
          s.settings.anchorPaydayThursday = s.finance.household.paydayAnchor || s.settings.anchorPaydayThursday;
          s.settings.reserveFloor = s.finance.household.reserveFloor;
          if (s.finance.balanceSnapshot) s.balance = s.finance.balanceSnapshot.amount;
          applyFinanceSourceDefaults(s);
        }
      } catch (financeError) {
        console.error('load finance ledger error:', financeError);
        s.finance.issue = 'Financial history could not be refreshed. The legacy schedule is shown as a temporary fallback.';
      }

      return s;
    } catch (e) {
      console.error('loadState error:', e);
      const fallback = clone(DEFAULTS);
      fallback.finance.issue = 'Household data could not load. The figures below are placeholders, not your saved budget.';
      return fallback;
    }
  }

  async function saveSettingsPatch(patch) {
    return withFinanceMutation(async () => {
      const { error } = await supabase.from('settings').update(patch).eq('user_id', USER_ID);
      if (error) throw error;
    });
  }

  function billDatabaseRow(bill) {
    const amount = Number(bill.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new TypeError('Bill amount must be a finite, nonnegative number.');
    }
    const row = {
      id:           bill.id,
      user_id:      USER_ID,
      name:         bill.name || '',
      amount,
      is_recurring: !!bill.recurring,
      recur_kind:   bill.recurKind || 'monthly',
      due_day:      Number(bill.recurDay ?? 1),
      due_date:     bill.dueDate || null,
      category:     bill.category || '',
      is_autodraft: !!bill.autodraft,
    };
    if (S.finance.available) {
      row.household_id = S.finance.household.id;
      row.archived_at = null;
    }
    return row;
  }

  async function saveBillRow(bill) {
    return withFinanceMutation(async () => {
      const { error } = await supabase.from('bills').upsert(billDatabaseRow(bill));
      if (error) throw error;
    });
  }

  async function removeBillRow(bill) {
    return withFinanceMutation(async () => {
      const query = S.finance.available
        ? supabase.from('bills').update({ archived_at: new Date().toISOString() }).eq('id', bill.id)
        : supabase.from('bills').delete().eq('id', bill.id);
      const { error } = await query;
      if (error) throw error;
    });
  }

  function archiveColumnUnavailable(error, column) {
    if (!error || !['42703', 'PGRST204'].includes(error.code)) return false;
    return JSON.stringify(error).toLowerCase().includes(column.toLowerCase());
  }

  async function upsertActiveRow(table, row, archiveColumn) {
    const activeRow = { ...row, [archiveColumn]: null };
    let result = await supabase.from(table).upsert(activeRow);
    if (archiveColumnUnavailable(result.error, archiveColumn)) {
      result = await supabase.from(table).upsert(row);
    }
    return result;
  }

  async function hardDeleteRow(table, id) {
    return supabase.from(table).delete().eq('id', id).eq('user_id', USER_ID);
  }

  async function archiveOrDeleteRow(table, id, archiveColumn) {
    const result = await supabase
      .from(table)
      .update({ [archiveColumn]: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', USER_ID);
    if (!result.error) return result;
    if (!archiveColumnUnavailable(result.error, archiveColumn)) return result;
    return hardDeleteRow(table, id);
  }

  async function savePaymentRow(payment) {
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new TypeError('One-time payment amount must be a finite, positive number.');
    }
    const row = {
      id:           payment.id,
      user_id:      USER_ID,
      name:         payment.name || '',
      amount,
      payment_date: payment.paymentDate,
    };
    if (S.finance.available) row.household_id = S.finance.household.id;
    return withFinanceMutation(async () => {
      const { error } = await upsertActiveRow('one_time_payments', row, 'archived_at');
      if (error) throw error;
    });
  }

  async function removePaymentRow(id) {
    return withFinanceMutation(async () => {
      const { error } = await archiveOrDeleteRow('one_time_payments', id, 'archived_at');
      if (error) throw error;
    });
  }

  // ── Meals & shared-list targeted save helpers ──────────────
  async function saveMealRow(meal) {
    const { error } = await upsertActiveRow('meals', {
      id:        meal.id,
      user_id:   USER_ID,
      meal_date: meal.date,
      name:      meal.name || '',
      notes:     meal.notes || '',
    }, 'deleted_at');
    if (error) console.error('saveMealRow error:', error);
  }
  async function deleteMealRow(id) {
    const { error } = await archiveOrDeleteRow('meals', id, 'deleted_at');
    if (error) console.error('deleteMealRow error:', error);
  }
  async function saveListRow(list) {
    const now = new Date().toISOString();
    list.updatedAt = now;
    const { error } = await upsertActiveRow('shared_lists', {
      id:         list.id,
      user_id:    USER_ID,
      title:      list.title || '',
      notes:      list.notes || '',
      created_at: list.createdAt || now,
      updated_at: now,
    }, 'archived_at');
    if (error) console.error('saveListRow error:', error);
    return !error;
  }
  async function deleteListRow(id) {
    const archivedAt = new Date().toISOString();
    const [itemsResult, listResult] = await Promise.all([
      supabase.from('shared_list_items').update({ deleted_at: archivedAt }).eq('list_id', id).eq('user_id', USER_ID),
      supabase.from('shared_lists').update({ archived_at: archivedAt }).eq('id', id).eq('user_id', USER_ID),
    ]);
    const failures = [
      { error: itemsResult.error, column: 'deleted_at' },
      { error: listResult.error, column: 'archived_at' },
    ].filter(result => result.error);
    const blockingFailure = failures.find(result => !archiveColumnUnavailable(result.error, result.column));
    if (blockingFailure) {
      console.error('deleteListRow error:', blockingFailure.error);
      return false;
    }
    if (failures.length) {
      const { error } = await hardDeleteRow('shared_lists', id);
      if (error) console.error('deleteListRow legacy fallback error:', error);
      return !error;
    }
    return true;
  }
  async function saveListItemRow(item) {
    const now = new Date().toISOString();
    item.updatedAt = now;
    const { error } = await upsertActiveRow('shared_list_items', {
      id:           item.id,
      list_id:      item.listId,
      user_id:      USER_ID,
      item_text:    item.text || '',
      is_completed: !!item.completed,
      sort_order:   Number(item.sortOrder) || 0,
      created_at:   item.createdAt || now,
      updated_at:   now,
    }, 'deleted_at');
    if (error) console.error('saveListItemRow error:', error);
    return !error;
  }
  async function deleteListItemRow(id) {
    const { error } = await archiveOrDeleteRow('shared_list_items', id, 'deleted_at');
    if (error) console.error('deleteListItemRow error:', error);
    return !error;
  }

  function parseIso(s) { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
  function sod(d) { return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
  function addDays(d,n) { const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  function toIso(d) { return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`; }
  function p2(n) { return String(n).padStart(2,'0'); }
  function diffDays(a,b) { return Math.round((sod(b)-sod(a))/86400000); }
  function fmtLong(d) { return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}); }
  function fmtShort(d) { return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
  function householdTimeZone() { return S.finance?.household?.timezone || 'America/Chicago'; }
  function businessDateIso(value = new Date()) {
    try {
      return isoDateInTimeZone(value, householdTimeZone());
    } catch (error) {
      console.warn('Using the household date fallback:', error);
      return isoDateInTimeZone(value, 'America/Chicago');
    }
  }
  function businessTodayDate() { return parseIso(businessDateIso()); }

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

  function activePaydayCycle(ref = new Date()) {
    const referenceDate = businessDateIso(ref);
    const anchor = S.finance.available
      ? S.finance.household.paydayAnchor
      : S.settings.anchorPaydayThursday;
    try {
      return paydayCycleFor(referenceDate, anchor);
    } catch {
      const fallback = calendarHalf(parseIso(referenceDate));
      return {
        startDate: toIso(fallback.start),
        endDateInclusive: toIso(fallback.end),
        endDateExclusive: toIso(addDays(fallback.end, 1)),
        nextPaydayDate: toIso(addDays(fallback.end, 1)),
        fallback: true,
      };
    }
  }

  function nextPaydayCycle(cycle) {
    return {
      startDate: cycle.endDateExclusive,
      endDateInclusive: addIsoDays(cycle.endDateExclusive, 13),
      endDateExclusive: addIsoDays(cycle.endDateExclusive, 14),
      nextPaydayDate: addIsoDays(cycle.endDateExclusive, 14),
      fallback: cycle.fallback,
    };
  }

  function dateInRange(date, startDate, endDateExclusive) {
    return date >= startDate && date < endDateExclusive;
  }

  function legacyFinanceOccurrences() {
    const today = businessTodayDate();
    const from = addDays(today, -370);
    const to = addDays(today, 420);
    const income = allIncome(S.settings, S.incomeOverrides, S.oneTimePayments, from, to).map(event => {
      const settled = sod(event.date) < today || !!S.clearedIncome[event.key];
      return {
        id: `legacy-income-${event.key}`,
        type: 'income',
        sourceKind: event.paymentId ? 'one_time_income' : 'legacy_income',
        sourceId: event.key,
        date: toIso(event.date),
        label: event.label,
        category: '',
        amount: Number(event.amount) || 0,
        actualAmount: settled ? Number(event.amount) || 0 : null,
        status: settled ? 'settled' : 'planned',
        inferred: true,
        adjusted: !!event.hasOverride,
        paymentId: event.paymentId,
      };
    });
    const bills = billsInHalf(S.bills, from, to, today).map(({ bill, date }) => {
      const bkey = `${bill.id}-${toIso(date)}`;
      const past = sod(date) < today;
      const settled = past ? !S.unpaidBills[bkey] : !!S.paidBills[bkey];
      return {
        id: `legacy-bill-${bkey}`,
        type: 'bill',
        sourceKind: bill.recurring ? 'bill_template' : 'one_time_bill',
        sourceId: bkey,
        billId: bill.id,
        legacyKey: bkey,
        date: toIso(date),
        label: bill.name || 'Unnamed bill',
        category: bill.category || '',
        amount: billOccurrenceAmount(bill, date),
        actualAmount: settled ? billOccurrenceAmount(bill, date) : null,
        status: settled ? 'settled' : 'planned',
        inferred: true,
        adjusted: S.billOverrides[bkey] != null && S.billOverrides[bkey] !== '',
        autodraft: !!bill.autodraft,
      };
    });
    return [...income, ...bills];
  }

  function financeOccurrences() {
    return S.finance.available
      ? S.finance.occurrences.filter(occurrence => !(
          occurrence.status === 'skipped'
          && occurrence.category === SCHEDULE_SUPERSEDED_CATEGORY
        ))
      : legacyFinanceOccurrences();
  }

  function sourceForSlug(slug) {
    return S.finance.incomeSources?.find(source => source.slug === slug);
  }

  function applyFinanceSourceDefaults(state = S) {
    const sources = state.finance?.incomeSources || [];
    const mappings = [
      ['salary', 'wifeWeekly'],
      ['payday', 'husbandPayday'],
      ['instapay', 'husbandInstapay'],
    ];
    mappings.forEach(([slug, stateKey]) => {
      const source = sources.find(item => item.slug === slug);
      if (source) state.settings[stateKey] = Number(source.defaultAmount) || 0;
    });
  }

  function weeklyAnchorFor(startDate, dayOfWeek) {
    let date = parseIso(startDate);
    const target = Math.max(0, Math.min(6, Number(dayOfWeek) || 0));
    while (date.getDay() !== target) date = addDays(date, -1);
    return toIso(date);
  }

  function occurrenceIdentity(occurrence) {
    return [occurrence.type, occurrence.sourceKind, String(occurrence.sourceId), occurrence.date].join('|');
  }

  function scheduleIdentity(occurrence) {
    return `${occurrence.sourceKind}|${occurrence.date}`;
  }

  function sourceIdentity(type, sourceKind, sourceId) {
    return [type, sourceKind, String(sourceId)].join('|');
  }

  function billScheduleRows(bill, startDate, endDateExclusive, { weeklyBuffer = false } = {}) {
    const rows = [];
    if (bill.recurring) {
      const cadence = bill.recurKind === 'weekly' ? 'weekly' : 'monthly';
      const materializeStart = cadence === 'weekly' && weeklyBuffer ? addIsoDays(startDate, -7) : startDate;
      const materializeEnd = cadence === 'weekly' && weeklyBuffer ? addIsoDays(endDateExclusive, 7) : endDateExclusive;
      const recurrence = cadence === 'weekly'
        ? { cadence, anchorDate: weeklyAnchorFor(startDate, bill.recurDay) }
        : { cadence, dayOfMonth: Math.max(1, Math.min(31, Number(bill.recurDay) || 1)) };
      materializeSchedule({
        id: bill.id,
        type: 'bill',
        label: bill.name || 'Unnamed bill',
        category: bill.category || '',
        defaultAmount: Number(bill.amount) || 0,
        recurrence,
      }, materializeStart, materializeEnd).forEach(row => rows.push({
        type: 'bill',
        sourceKind: 'bill_template',
        sourceId: bill.id,
        date: row.date,
        label: row.label,
        category: row.category,
        amount: row.amount,
        status: 'planned',
        inferred: false,
        adjusted: false,
        autodraft: !!bill.autodraft,
      }));
    } else if (bill.dueDate && dateInRange(bill.dueDate, startDate, endDateExclusive)) {
      rows.push({
        type: 'bill',
        sourceKind: 'one_time_bill',
        sourceId: bill.id,
        date: bill.dueDate,
        label: bill.name || 'One-time bill',
        category: bill.category || '',
        amount: Number(bill.amount) || 0,
        status: 'planned',
        inferred: false,
        adjusted: false,
        autodraft: !!bill.autodraft,
      });
    }
    return rows;
  }

  async function reconcileBillSchedule(bill, {
    candidates,
    guardCandidates = candidates,
    loaded,
    staleEligible,
  }) {
    const sourceRows = loaded.filter(occurrence =>
      occurrence.type === 'bill'
      && ['bill_template', 'one_time_bill'].includes(occurrence.sourceKind)
      && String(occurrence.sourceId) === String(bill.id),
    );
    const expected = new Set(candidates.map(scheduleIdentity));
    const guarded = new Set(billScheduleGuardIdentities({
      candidates: guardCandidates,
      existingOccurrences: sourceRows,
      cadence: bill.recurKind === 'weekly' ? 'weekly' : 'monthly',
      targetSourceKind: bill.recurring ? 'bill_template' : 'one_time_bill',
      sourceId: bill.id,
    }));

    // Restore current auto-guards first. If this fails, old planned rows are
    // deliberately left in place so the forecast can overstate, never omit.
    const reactivations = sourceRows.filter(occurrence =>
      occurrence.status === 'skipped'
      && occurrence.category === SCHEDULE_SUPERSEDED_CATEGORY
      && expected.has(scheduleIdentity(occurrence))
      && !guarded.has(scheduleIdentity(occurrence)),
    );
    if (reactivations.length) {
      await Promise.all(reactivations.map(occurrence => patchOccurrence(supabase, occurrence.id, {
        status: 'planned',
        actualAmount: null,
        settledAt: null,
        category: bill.category || '',
        label: bill.name || (bill.recurring ? 'Unnamed bill' : 'One-time bill'),
        autodraft: !!bill.autodraft,
        inferred: false,
      })));
    }

    // Materialization has already happened. Guarding now means an interrupted
    // edit can only leave an extra commitment, not silently remove one.
    const newGuards = sourceRows.filter(occurrence =>
      occurrence.status === 'planned'
      && expected.has(scheduleIdentity(occurrence))
      && guarded.has(scheduleIdentity(occurrence)),
    );
    if (newGuards.length) {
      await Promise.all(newGuards.map(occurrence => patchOccurrence(supabase, occurrence.id, {
        status: 'skipped',
        actualAmount: null,
        settledAt: null,
        category: SCHEDULE_SUPERSEDED_CATEGORY,
        inferred: false,
      })));
    }

    const stale = sourceRows.filter(occurrence =>
      occurrence.status === 'planned'
      && !occurrence.adjusted
      && !expected.has(scheduleIdentity(occurrence))
      && staleEligible(occurrence),
    );
    if (stale.length) {
      await Promise.all(stale.map(occurrence => patchOccurrence(supabase, occurrence.id, {
        status: 'skipped',
        actualAmount: null,
        settledAt: null,
        category: SCHEDULE_SUPERSEDED_CATEGORY,
        inferred: false,
      })));
    }
    return reactivations.length > 0 || newGuards.length > 0 || stale.length > 0;
  }

  async function ensureFinanceRange(startDate, endDateExclusive) {
    if (!S.finance.available) return;
    const todayIso = businessDateIso();
    const safeStartDate = startDate < todayIso ? todayIso : startDate;
    if (safeStartDate >= endDateExclusive) return;
    const generated = [];

    for (const source of S.finance.incomeSources.filter(item => item.active && item.anchorDate)) {
        const sourceStartDate = source.effectiveFrom && source.effectiveFrom > safeStartDate
          ? source.effectiveFrom
          : safeStartDate;
        const sourceEndDate = source.effectiveThrough
          ? [endDateExclusive, addIsoDays(source.effectiveThrough, 1)].sort()[0]
          : endDateExclusive;
        if (sourceStartDate >= sourceEndDate) continue;
        const recurrence = source.cadence === 'monthly'
          ? { cadence: 'monthly', dayOfMonth: parseIso(source.anchorDate).getDate() }
          : { cadence: source.cadence, anchorDate: source.anchorDate };
        const rows = materializeSchedule({
          id: source.id,
          type: 'income',
          label: source.name,
          defaultAmount: source.defaultAmount,
          recurrence,
        }, sourceStartDate, sourceEndDate);
        rows.forEach(row => generated.push({
          type: 'income',
          sourceKind: 'income_source',
          sourceId: source.id,
          date: row.date,
          label: row.label,
          category: '',
          amount: row.amount,
          status: 'planned',
          inferred: false,
          adjusted: false,
        }));
    }

    S.bills.forEach(bill => generated.push(...billScheduleRows(bill, safeStartDate, endDateExclusive)));

    S.oneTimePayments.forEach(payment => {
      if (!payment.paymentDate || !dateInRange(payment.paymentDate, safeStartDate, endDateExclusive)) return;
      generated.push({
        type: 'income',
        sourceKind: 'one_time_income',
        sourceId: payment.id,
        date: payment.paymentDate,
        label: payment.name || 'One-time payment',
        category: '',
        amount: Number(payment.amount) || 0,
        status: 'planned',
        inferred: false,
        adjusted: false,
      });
    });

    await materializeOccurrences(supabase, S.finance.household.id, generated);
    let loaded = await reloadOccurrences(supabase, S.finance.household.id);

    const expected = new Set(generated.map(occurrenceIdentity));
    const managedSources = new Set();
    S.finance.incomeSources.filter(source => source.active).forEach(source => {
      managedSources.add(sourceIdentity('income', 'income_source', source.id));
    });
    S.bills.forEach(bill => {
      managedSources.add(sourceIdentity('bill', 'bill_template', bill.id));
      managedSources.add(sourceIdentity('bill', 'one_time_bill', bill.id));
    });
    S.oneTimePayments.forEach(payment => {
      managedSources.add(sourceIdentity('income', 'one_time_income', payment.id));
    });

    let scheduleRepaired = false;
    for (const bill of S.bills) {
      const candidates = generated.filter(occurrence =>
        occurrence.type === 'bill' && String(occurrence.sourceId) === String(bill.id),
      );
      const guardCandidates = bill.recurring && bill.recurKind === 'weekly'
        ? billScheduleRows(bill, safeStartDate, endDateExclusive, { weeklyBuffer: true })
        : candidates;
      scheduleRepaired = await reconcileBillSchedule(bill, {
        candidates,
        guardCandidates,
        loaded,
        staleEligible: occurrence => dateInRange(occurrence.date, safeStartDate, endDateExclusive),
      }) || scheduleRepaired;
    }

    const stale = loaded.filter(occurrence =>
      occurrence.status === 'planned'
      && !occurrence.adjusted
      && occurrence.type === 'income'
      && dateInRange(occurrence.date, safeStartDate, endDateExclusive)
      && managedSources.has(sourceIdentity(occurrence.type, occurrence.sourceKind, occurrence.sourceId))
      && !expected.has(occurrenceIdentity(occurrence)));
    if (stale.length) {
      await Promise.all(stale.map(occurrence => patchOccurrence(supabase, occurrence.id, {
        status: 'skipped',
        actualAmount: null,
        settledAt: null,
        category: SCHEDULE_SUPERSEDED_CATEGORY,
        inferred: false,
      })));
    }

    if (scheduleRepaired || stale.length) loaded = await reloadOccurrences(supabase, S.finance.household.id);

    const cents = value => Math.round((Number(value) || 0) * 100);
    const repairs = [];
    S.finance.incomeSources.filter(source => source.active).forEach(source => {
      const mismatched = loaded.some(occurrence =>
        occurrence.type === 'income'
        && occurrence.sourceKind === 'income_source'
        && occurrence.sourceId === source.id
        && occurrence.status === 'planned'
        && occurrence.date >= safeStartDate
        && (occurrence.label !== source.name
          || (!occurrence.adjusted && cents(occurrence.amount) !== cents(source.defaultAmount))));
      if (mismatched) repairs.push(updateFutureSourceAmounts(supabase, {
        householdId: S.finance.household.id,
        direction: 'income',
        sourceKind: 'income_source',
        sourceId: source.id,
        fromDate: safeStartDate,
        amount: source.defaultAmount,
        label: source.name,
      }));
    });
    S.bills.forEach(bill => {
      const sourceKind = bill.recurring ? 'bill_template' : 'one_time_bill';
      const mismatched = loaded.some(occurrence =>
        occurrence.type === 'bill'
        && occurrence.sourceKind === sourceKind
        && occurrence.sourceId === bill.id
        && occurrence.status === 'planned'
        && occurrence.date >= safeStartDate
        && (occurrence.label !== (bill.name || 'Unnamed bill')
          || occurrence.category !== (bill.category || '')
          || occurrence.autodraft !== !!bill.autodraft
          || (!occurrence.adjusted && cents(occurrence.amount) !== cents(bill.amount))));
      if (mismatched) repairs.push(updateFutureSourceAmounts(supabase, {
        householdId: S.finance.household.id,
        direction: 'expense',
        sourceKind,
        sourceId: bill.id,
        fromDate: safeStartDate,
        amount: Number(bill.amount) || 0,
        label: bill.name || 'Unnamed bill',
        category: bill.category || '',
        autodraft: !!bill.autodraft,
      }));
    });
    if (repairs.length) await Promise.all(repairs);
    if (repairs.length) loaded = await reloadOccurrences(supabase, S.finance.household.id);
    S.finance.occurrences = loaded;
  }

  async function initializeFinanceLedger() {
    if (!S.finance.available) return;
    const cycle = activePaydayCycle();
    await ensureFinanceRange(cycle.startDate, addIsoDays(cycle.startDate, 400));
    if (S.finance.balanceSnapshot) {
      S.balance = S.finance.balanceSnapshot.amount;
    }
  }

  let financeReloadTimer = null;
  let financeReloadGeneration = 0;
  let financeReloadPending = false;
  let financeReloadInFlight = false;

  function financeWriteIsInFlight() {
    return financeMutationCount > 0
      || (typeof billSaveStates !== 'undefined' && billSaveStates.size > 0);
  }

  function flushDeferredFinanceReload() {
    if (financeReloadPending && !financeDraftIsActive()) scheduleFinanceReload();
  }

  function financeDraftIsActive() {
    const active = document.activeElement;
    const activeFinanceControl = !!active?.closest?.('#view-budget') && (
      active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement
    );
    return activeFinanceControl
      || financeWriteIsInFlight()
      || document.getElementById('balance-save')?.classList.contains('is-dirty');
  }

  function scheduleFinanceReload() {
    financeReloadGeneration += 1;
    const generation = financeReloadGeneration;
    clearTimeout(financeReloadTimer);
    financeReloadTimer = setTimeout(() => reloadFinanceState(generation), 450);
  }

  async function reloadFinanceState(generation = financeReloadGeneration) {
    if (!S.finance.available) return;
    if (financeReloadInFlight) {
      financeReloadPending = true;
      return;
    }
    if (financeDraftIsActive()) {
      financeReloadPending = true;
      if (financeWriteIsInFlight()) {
        clearTimeout(financeReloadTimer);
        financeReloadTimer = setTimeout(() => reloadFinanceState(financeReloadGeneration), 650);
      }
      return;
    }
    financeReloadInFlight = true;
    try {
      const [finance, billsResult, paymentsResult] = await Promise.all([
        loadFinanceLedger(supabase),
        supabase.from('bills').select('*').eq('user_id', USER_ID),
        supabase.from('one_time_payments').select('*').eq('user_id', USER_ID),
      ]);
      if (billsResult.error) throw billsResult.error;
      if (paymentsResult.error) throw paymentsResult.error;
      if (!finance.available) throw new Error('Financial history is temporarily unavailable.');
      if (generation !== financeReloadGeneration) return;
      if (financeDraftIsActive()) {
        financeReloadPending = true;
        return;
      }

      S.finance = finance;
      S.settings.anchorPaydayThursday = finance.household.paydayAnchor || S.settings.anchorPaydayThursday;
      S.settings.reserveFloor = finance.household.reserveFloor;
      if (finance.balanceSnapshot) S.balance = finance.balanceSnapshot.amount;
      applyFinanceSourceDefaults(S);
      S.bills = (billsResult.data || []).filter(bill => !bill.archived_at).map(bill => ({
        id: bill.id,
        name: bill.name || '',
        amount: bill.amount ?? '',
        recurring: !!bill.is_recurring,
        recurKind: bill.recur_kind || 'monthly',
        recurDay: bill.due_day ?? 1,
        dueDate: bill.due_date || '',
        autodraft: !!bill.is_autodraft,
        category: bill.category || '',
        archivedAt: bill.archived_at || null,
      }));
      S.oneTimePayments = (paymentsResult.data || []).filter(payment => !payment.archived_at).map(payment => ({
        id: payment.id,
        name: payment.name || '',
        amount: payment.amount ?? '',
        paymentDate: payment.payment_date || '',
      }));
      await initializeFinanceLedger();
      if (generation !== financeReloadGeneration || financeDraftIsActive()) {
        financeReloadPending = true;
        return;
      }
      financeReloadPending = false;
      clearFinanceIssue();
      refreshFinanceViews();
    } catch (error) {
      console.error('reloadFinanceState error:', error);
      showFinanceIssue('Financial history could not refresh. Displayed figures may be out of date; retry by reopening the app.');
    } finally {
      financeReloadInFlight = false;
      flushDeferredFinanceReload();
    }
  }

  function sharedDraftIsActive() {
    const active = document.activeElement;
    return !!active?.closest?.('#view-week') && (
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    );
  }

  async function reloadSharedState() {
    if (sharedDraftIsActive()) {
      sharedReloadPending = true;
      return;
    }
    try {
      const [mealsResult, listsResult, itemsResult] = await Promise.all([
        supabase.from('meals').select('*').eq('user_id', USER_ID),
        supabase.from('shared_lists').select('*').eq('user_id', USER_ID),
        supabase.from('shared_list_items').select('*').eq('user_id', USER_ID),
      ]);
      if (mealsResult.error) throw mealsResult.error;
      if (listsResult.error) throw listsResult.error;
      if (itemsResult.error) throw itemsResult.error;

      S.meals = (mealsResult.data || []).filter(meal => !meal.deleted_at).map(meal => ({
        id: meal.id,
        date: meal.meal_date,
        name: meal.name || '',
        notes: meal.notes || '',
      }));
      S.lists = (listsResult.data || []).filter(list => !list.archived_at).map(list => ({
        id: list.id,
        title: list.title || '',
        notes: list.notes || '',
        createdAt: list.created_at || '',
        updatedAt: list.updated_at || list.created_at || '',
      }));
      const activeListIds = new Set(S.lists.map(list => list.id));
      S.listItems = (itemsResult.data || [])
        .filter(item => !item.deleted_at && activeListIds.has(item.list_id))
        .map(item => ({
          id: item.id,
          listId: item.list_id,
          text: item.item_text || '',
          completed: !!item.is_completed,
          sortOrder: Number(item.sort_order) || 0,
          createdAt: item.created_at || '',
          updatedAt: item.updated_at || item.created_at || '',
        }));
      sharedReloadPending = false;
      renderToday();
      renderMealsStrip();
      renderLists();
    } catch (error) {
      console.error('reload shared state error:', error);
    }
  }

  let sharedReloadTimer = null;
  let sharedReloadPending = false;
  function setupFinanceRealtime() {
    if (!S.finance.available) return null;
    const householdId = S.finance.household.id;
    const scheduleSharedReload = () => {
      clearTimeout(sharedReloadTimer);
      sharedReloadTimer = setTimeout(reloadSharedState, 450);
    };
    const channel = supabase.channel(`ghp-finance-${householdId}`);
    ['cashflow_occurrences', 'balance_snapshots', 'income_sources', 'bills', 'one_time_payments'].forEach(table => {
      channel.on('postgres_changes', {
        event: '*', schema: 'public', table, filter: `household_id=eq.${householdId}`,
      }, scheduleFinanceReload);
    });
    channel.on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'households', filter: `id=eq.${householdId}`,
    }, scheduleFinanceReload);
    ['meals', 'shared_lists', 'shared_list_items'].forEach(table => {
      channel.on('postgres_changes', {
        event: '*', schema: 'public', table, filter: `user_id=eq.${USER_ID}`,
      }, scheduleSharedReload);
    });
    channel.subscribe(status => {
      if (status === 'CHANNEL_ERROR') console.warn('Finance realtime channel unavailable; visibility refresh remains active.');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleFinanceReload();
        scheduleSharedReload();
      }
    });
    document.addEventListener('focusout', () => {
      if (sharedReloadPending) setTimeout(scheduleSharedReload, 0);
      if (financeReloadPending) setTimeout(scheduleFinanceReload, 0);
    });
    return channel;
  }

  function replaceFinanceOccurrence(updated) {
    const index = S.finance.occurrences.findIndex(item => item.id === updated.id);
    if (index >= 0) S.finance.occurrences[index] = updated;
    else S.finance.occurrences.push(updated);
  }

  async function setOccurrenceSettled(occurrence, settled) {
    if (S.finance.available) {
      const updated = await patchOccurrence(supabase, occurrence.id, {
        status: settled ? 'settled' : 'planned',
        actualAmount: settled ? occurrence.amount : null,
        settledAt: settled ? new Date().toISOString() : null,
        inferred: false,
      });
      replaceFinanceOccurrence(updated);
      return;
    }

    if (occurrence.type === 'income') {
      if (settled) S.clearedIncome[occurrence.sourceId] = true;
      else delete S.clearedIncome[occurrence.sourceId];
      await saveSettingsPatch({ cleared_income: S.clearedIncome });
      return;
    }

    const key = occurrence.legacyKey || occurrence.sourceId;
    const past = occurrence.date < businessDateIso();
    if (settled) {
      S.paidBills[key] = true;
      delete S.unpaidBills[key];
    } else if (past) {
      delete S.paidBills[key];
      S.unpaidBills[key] = true;
    } else {
      delete S.paidBills[key];
      delete S.unpaidBills[key];
    }
    await saveSettingsPatch({ paid_bills: S.paidBills, unpaid_bills: S.unpaidBills });
  }

  async function setOccurrenceAmount(occurrence, amount, baseAmount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) return;
    const adjusted = Number(value) !== Number(baseAmount);
    if (S.finance.available) {
      const updated = await patchOccurrence(supabase, occurrence.id, {
        amount: value,
        actualAmount: occurrence.status === 'settled' ? value : null,
        adjusted,
        inferred: false,
      });
      replaceFinanceOccurrence(updated);
      return;
    }

    const overrides = occurrence.type === 'income' ? S.incomeOverrides : S.billOverrides;
    const key = occurrence.type === 'income' ? occurrence.sourceId : (occurrence.legacyKey || occurrence.sourceId);
    if (adjusted) overrides[key] = String(value);
    else delete overrides[key];
    const column = occurrence.type === 'income' ? 'income_overrides' : 'bill_overrides';
    await saveSettingsPatch({ [column]: overrides });
  }

  async function saveOccurrenceEdits(occurrence, { label, amount, date }) {
    return withFinanceMutation(async () => {
      const isOneTimeIncome = occurrence.sourceKind === 'one_time_income';
      const isOneTimeBill = occurrence.sourceKind === 'one_time_bill';

      if (isOneTimeIncome) {
        const payment = S.oneTimePayments.find(item => String(item.id) === String(occurrence.sourceId));
        if (payment) {
          const updatedPayment = { ...payment, name: label, amount, paymentDate: date };
          await savePaymentRow(updatedPayment);
          Object.assign(payment, updatedPayment);
        }
      } else if (isOneTimeBill) {
        const bill = S.bills.find(item => String(item.id) === String(occurrence.sourceId));
        if (bill) {
          const updatedBill = { ...bill, name: label, amount, dueDate: date };
          await saveBillRow(updatedBill);
          Object.assign(bill, updatedBill);
        }
      }

      if (date !== occurrence.date && !isOneTimeIncome && !isOneTimeBill) {
        const guard = await patchOccurrence(supabase, occurrence.id, {
          status: 'skipped',
          actualAmount: null,
          settledAt: null,
          category: SCHEDULE_SUPERSEDED_CATEGORY,
          inferred: false,
        });
        replaceFinanceOccurrence(guard);
        try {
          const moved = await saveOccurrence(supabase, S.finance.household.id, {
            ...occurrence,
            id: undefined,
            date,
            label,
            amount,
            actualAmount: null,
            status: 'planned',
            settledAt: null,
            adjusted: true,
            inferred: false,
            category: occurrence.category === SCHEDULE_SUPERSEDED_CATEGORY ? '' : occurrence.category,
          });
          replaceFinanceOccurrence(moved);
        } catch (error) {
          const restored = await patchOccurrence(supabase, occurrence.id, {
            status: 'planned',
            category: occurrence.category,
            inferred: false,
          });
          replaceFinanceOccurrence(restored);
          throw error;
        }
        return;
      }

      const updated = await patchOccurrence(supabase, occurrence.id, {
        date,
        label,
        amount,
        actualAmount: null,
        adjusted: true,
        inferred: false,
      });
      replaceFinanceOccurrence(updated);
    });
  }

  async function saveOneTimeBill(bill, onSourceSaved = () => {}) {
    return withFinanceMutation(async () => {
      await saveBillRow(bill);
      onSourceSaved();
      if (!S.finance.available) return null;
      const created = await saveOccurrence(supabase, S.finance.household.id, {
        type: 'bill', sourceKind: 'one_time_bill', sourceId: bill.id,
        date: bill.dueDate, label: bill.name, category: '', amount: bill.amount,
        status: 'planned', inferred: false, adjusted: false, autodraft: false,
      });
      replaceFinanceOccurrence(created);
      return created;
    });
  }

  async function saveOneTimePayment(payment, onSourceSaved = () => {}) {
    return withFinanceMutation(async () => {
      await savePaymentRow(payment);
      onSourceSaved();
      if (!S.finance.available) return null;
      const created = await saveOccurrence(supabase, S.finance.household.id, {
        type: 'income', sourceKind: 'one_time_income', sourceId: payment.id,
        date: payment.paymentDate, label: payment.name, category: '', amount: payment.amount,
        status: 'planned', inferred: false, adjusted: false,
      });
      replaceFinanceOccurrence(created);
      return created;
    });
  }

  async function removeOneTimeOccurrence(occurrence) {
    return withFinanceMutation(async () => {
      if (occurrence.sourceKind === 'one_time_income') {
        const paymentId = occurrence.paymentId || occurrence.sourceId;
        await removePaymentRow(paymentId);
        S.oneTimePayments = S.oneTimePayments.filter(payment => payment.id !== paymentId);
      } else if (occurrence.sourceKind === 'one_time_bill') {
        const billId = occurrence.billId || occurrence.sourceId;
        const bill = S.bills.find(item => item.id === billId);
        if (bill) {
          await removeBillRow(bill);
          S.bills = S.bills.filter(item => item.id !== billId);
        }
      }
      if (S.finance.available) await deleteOccurrence(supabase, occurrence.id);
      S.finance.occurrences = S.finance.occurrences.filter(item => item.id !== occurrence.id);
    });
  }

  function openOccurrenceEditor(occurrence) {
    document.querySelector('.occurrence-edit-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.className = 'occurrence-edit-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="occurrence-edit-form">
        <div class="occurrence-edit-heading">
          <div>
            <strong>Edit this occurrence</strong>
            <small>${['one_time_bill', 'one_time_income'].includes(occurrence.sourceKind)
              ? 'Updates this one-time item'
              : 'Only this date — the recurring setup stays unchanged'}</small>
          </div>
          <button type="button" class="occurrence-edit-close" aria-label="Close">×</button>
        </div>
        <label>Title<input name="label" type="text" required value="${esc(occurrence.label)}"></label>
        <div class="occurrence-edit-grid">
          <label>Amount<input name="amount" type="number" min="0" step="0.01" required value="${Number(occurrence.actualAmount ?? occurrence.amount)}"></label>
          <label>${occurrence.type === 'bill' ? 'Pull / due date' : 'Payment date'}<input name="date" type="date" required value="${esc(occurrence.date)}"></label>
        </div>
        <div class="occurrence-edit-actions">
          <button type="button" class="btn ghost occurrence-edit-cancel">Cancel</button>
          <button type="submit" class="btn occurrence-edit-save">Save changes</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    const close = () => dialog.close();
    dialog.querySelector('.occurrence-edit-close').addEventListener('click', close);
    dialog.querySelector('.occurrence-edit-cancel').addEventListener('click', close);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) close();
    });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const saveButton = form.querySelector('.occurrence-edit-save');
      const edits = {
        label: form.elements.label.value.trim(),
        amount: Number(form.elements.amount.value),
        date: form.elements.date.value,
      };
      if (!edits.label || !Number.isFinite(edits.amount) || edits.amount < 0 || !edits.date) return;
      saveButton.disabled = true;
      try {
        await saveOccurrenceEdits(occurrence, edits);
        close();
        renderWeek();
        renderDashboard();
        renderMonthlyReport();
        renderBillsTable();
        renderSchedule();
      } catch (error) {
        console.error('edit occurrence error:', error);
        alert('Those changes did not save. Please try again.');
        saveButton.disabled = false;
      }
    });
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector('input[name="label"]').focus();
  }

  async function syncBillOccurrences(bill, scheduleChanged = false) {
    if (!S.finance.available) return;
    const todayIso = businessDateIso();
    if (scheduleChanged) {
      const endDateExclusive = addIsoDays(todayIso, 400);
      const plannedRows = billScheduleRows(bill, todayIso, endDateExclusive);
      const guardCandidates = bill.recurring && bill.recurKind === 'weekly'
        ? billScheduleRows(bill, todayIso, endDateExclusive, { weeklyBuffer: true })
        : plannedRows;

      // Insert the replacement schedule before suppressing anything. A network
      // interruption therefore leaves a conservative duplicate, never a gap.
      await materializeOccurrences(supabase, S.finance.household.id, plannedRows);
      const loaded = await reloadOccurrences(supabase, S.finance.household.id);
      await reconcileBillSchedule(bill, {
        candidates: plannedRows,
        guardCandidates,
        loaded,
        staleEligible: occurrence => occurrence.date >= todayIso
          || (!bill.recurring && occurrence.sourceKind === 'one_time_bill'),
      });
      const sourceKind = bill.recurring ? 'bill_template' : 'one_time_bill';
      await updateFutureSourceAmounts(supabase, {
        householdId: S.finance.household.id,
        direction: 'expense',
        sourceKind,
        sourceId: bill.id,
        fromDate: todayIso,
        amount: Number(bill.amount) || 0,
        label: bill.name || 'Unnamed bill',
        category: bill.category || '',
        autodraft: !!bill.autodraft,
      });
      S.finance.occurrences = await reloadOccurrences(supabase, S.finance.household.id);
      return;
    }
    const sourceKind = bill.recurring ? 'bill_template' : 'one_time_bill';
    await updateFutureSourceAmounts(supabase, {
      householdId: S.finance.household.id,
      direction: 'expense',
      sourceKind,
      sourceId: bill.id,
      fromDate: bill.recurring ? todayIso : '1900-01-01',
      amount: Number(bill.amount) || 0,
      label: bill.name || 'Unnamed bill',
      category: bill.category || '',
      autodraft: !!bill.autodraft,
    });
    S.finance.occurrences = await reloadOccurrences(supabase, S.finance.household.id);
  }

  let selectedMonthId = businessDateIso().slice(0, 7);

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
        // Monthly: emit one occurrence for every calendar month touched by the
        // range. Checking only the boundary months made a long fallback window
        // silently omit all monthly bills in the middle.
        const dom = b.recurDay || 1;
        let monthCursor = new Date(rs.getFullYear(), rs.getMonth(), 1);
        const finalMonth = new Date(re.getFullYear(), re.getMonth(), 1);
        while (monthCursor <= finalMonth) {
          const y = monthCursor.getFullYear();
          const m = monthCursor.getMonth();
          const lastDay = new Date(y, m + 1, 0).getDate();
          const clampedDom = Math.min(dom, lastDay);
          const candidate = new Date(y, m, clampedDom);
          if (candidate >= rs && candidate <= re) {
            results.push({ bill: b, date: candidate });
          }
          monthCursor = new Date(y, m + 1, 1);
        }
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

  function validatedAmountInput(input, { allowZero = false, restoreValue } = {}) {
    const raw = input.value.trim();
    const value = Number(raw);
    const valid = raw !== '' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
    if (valid) {
      input.setCustomValidity('');
      input.removeAttribute('aria-invalid');
      return value;
    }

    if (restoreValue !== undefined) input.value = restoreValue;
    input.setCustomValidity(allowZero
      ? 'Enter a valid amount of $0 or more.'
      : 'Enter a valid amount greater than $0.');
    input.setAttribute('aria-invalid', 'true');
    input.reportValidity();
    input.focus();
    input.select();
    input.addEventListener('input', () => {
      input.setCustomValidity('');
      input.removeAttribute('aria-invalid');
    }, { once: true });
    return null;
  }

  function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

  const $  = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  function showFinanceIssue(message) {
    const element = $('#boot-error');
    if (!element) return;
    element.className = 'boot-error visible';
    element.dataset.issueKind = 'finance';
    element.textContent = message;
  }

  function clearFinanceIssue() {
    const element = $('#boot-error');
    if (!element || element.dataset.issueKind !== 'finance') return;
    element.className = 'boot-error';
    element.textContent = '';
    delete element.dataset.issueKind;
  }

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
        .filter(b => b.recurring && b.category === c.key)
        .reduce((s,b) => s + billMonthlyEquivalent(b), 0);
      return `<div class="cat-total"><div class="cat-lbl">${c.label}</div><div class="cat-amt">${money(total)}</div></div>`;
    }).join('') + `<div class="cat-total" style="border-color:rgba(91,141,239,.2)"><div class="cat-lbl" style="color:var(--accent)">Recurring baseline</div><div class="cat-amt" style="color:var(--accent)">${money(S.bills.filter(b => b.recurring).reduce((s,b) => s + billMonthlyEquivalent(b), 0))}</div></div>`;
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
    const todayIso = businessDateIso();
    const targetIso = toIso(sod(targetDate));
    if (targetIso < todayIso) {
      return { running: Number(S.balance) || 0, minRunning: Number(S.balance) || 0, minDate: parseIso(todayIso) };
    }
    const forecast = forecastTimeline({
      openingBalance: Number(S.balance) || 0,
      startDate: todayIso,
      endDateExclusive: addIsoDays(targetIso, 1),
      occurrences: financeOccurrences(),
      floor: Number(S.settings.reserveFloor) || 0,
      includeOverdueBills: true,
    });
    return {
      running: forecast.endingBalance,
      minRunning: forecast.minimumBalance,
      minDate: parseIso(forecast.minimumDate),
    };
  }

  function renderToday() {
    const todayIso = businessDateIso();
    const meal = S.meals.find(m => m.date === todayIso);
    const dateLabel = fmtLong(parseIso(todayIso));
    const openItems = activeListItems().filter(item => !item.completed).length;

    const mealLine = meal && meal.name
      ? `<div class="today-focus"><span class="today-lbl">Dinner</span><strong>${esc(meal.name)}</strong>${meal.notes ? `<span class="today-meta">${esc(meal.notes)}</span>` : ''}</div>`
      : `<div class="today-focus"><span class="today-lbl">Dinner</span><span class="today-empty">No meal planned yet</span></div>`;

    document.getElementById('today-title').textContent = `Today · ${dateLabel}`;
    document.getElementById('today-content').innerHTML =
      `<div class="today-stack">${mealLine}
        <div class="today-metrics">
          <div><span>Open list items</span><strong>${openItems}</strong></div>
        </div>
      </div>`;
  }

  function renderSnapshots() {
    const todayIso = businessDateIso();
    const today = parseIso(todayIso);
    const cycle = activePaydayCycle();
    const reserveFloor = Number(S.settings.reserveFloor) || 0;
    const position = currentCashPosition({
      bankBalance: Number(S.balance) || 0,
      asOfDate: todayIso,
      cycleEndDateExclusive: cycle.endDateExclusive,
      occurrences: financeOccurrences(),
      floor: reserveFloor,
    });
    const balanceLabel = document.querySelector('#snapshot-now-card .hero-label');
    if (balanceLabel) balanceLabel.textContent = 'Bank now';
    document.getElementById('snapshot-now').textContent = money(position.bankBalance);
    const snapshot = S.finance.balanceSnapshot;
    const snapshotDate = snapshot?.asOf ? new Date(snapshot.asOf) : null;
    const staleDays = snapshotDate && !Number.isNaN(snapshotDate.valueOf())
      ? Math.max(0, diffDays(snapshotDate, today))
      : null;
    document.getElementById('snapshot-now-sub').innerHTML = snapshotDate
      ? `<div>Updated ${staleDays === 0 ? 'today' : `${staleDays} day${staleDays === 1 ? '' : 's'} ago`}</div><div>${fmtLong(snapshotDate)}</div>`
      : `<div>Manual balance</div><div>${fmtLong(today)}</div>`;
    const nowCard = document.getElementById('snapshot-now-card');
    nowCard.classList.remove('safe','warn','danger');
    nowCard.classList.add(position.bankBalance <= 0 ? 'danger' : position.bankBalance < reserveFloor ? 'warn' : 'safe');

    document.getElementById('snapshot-next-label').textContent = 'Uncommitted this cycle';
    document.getElementById('snapshot-next').textContent = money(position.uncommitted);
    const nextSub = position.forecastFloor < 0
      ? `<div>⚠ Short by ${money(Math.abs(position.forecastFloor))}</div><div>on ${fmtShort(parseIso(position.forecastFloorDate))}</div>`
      : `<div>After known bills</div><div>through ${fmtLong(parseIso(cycle.endDateInclusive))}</div>`;
    document.getElementById('snapshot-next-sub').innerHTML = nextSub;
    const nextCard = document.getElementById('snapshot-next-card');
    nextCard.classList.remove('safe','warn','danger');
    nextCard.classList.add(position.forecastFloor < 0 || position.uncommitted < 0 ? 'danger' : position.forecastFloor < reserveFloor ? 'warn' : 'safe');
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
    const today = businessTodayDate();
    const series = Array.from({ length: 14 }, (_, index) => {
      const date = addDays(today, index);
      return { date, value: runningBalanceAt(date).running };
    });
    const todayIso = businessDateIso();
    const fullForecast = forecastTimeline({
      openingBalance: Number(S.balance) || 0,
      startDate: todayIso,
      endDateExclusive: addIsoDays(todayIso, 14),
      occurrences: financeOccurrences(),
      floor: Number(S.settings.reserveFloor) || 0,
      includeOverdueBills: true,
    });
    const values = series.map(point => point.value);
    let min = Math.min(fullForecast.minimumBalance, ...values);
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
    const minimumIndex = Math.max(0, Math.min(series.length - 1,
      diffDays(today, parseIso(fullForecast.minimumDate))));
    const minimumX = x(minimumIndex);
    const minimumEndpoint = series[minimumIndex].value;
    const minimumStem = Math.abs(minimumEndpoint - fullForecast.minimumBalance) >= 0.005
      ? `<line x1="${minimumX}" y1="${y(minimumEndpoint)}" x2="${minimumX}" y2="${y(fullForecast.minimumBalance)}" stroke="var(--danger)" stroke-width="2" stroke-dasharray="3 3" />`
      : '';
    const minimumMarker = `${minimumStem}<circle cx="${minimumX}" cy="${y(fullForecast.minimumBalance)}" r="5" class="chart-dot${fullForecast.minimumBalance < 0 ? ' is-negative' : ''}"><title>Lowest balance ${fmtLong(parseIso(fullForecast.minimumDate))}: ${money(fullForecast.minimumBalance)} (includes bill-before-income timing)</title></circle>`;
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
      ${dots}${minimumMarker}
      ${labels}
    </svg>
    <div class="chart-caption"><span>Today ${money(series[0].value)}</span><span>Lowest ${money(fullForecast.minimumBalance)} · ${fmtShort(parseIso(fullForecast.minimumDate))} · day 14 ${money(series[13].value)}</span></div>`;
  }

  function renderBudgetForecast(cycle, nextCycle) {
    const host = document.getElementById('budget-forecast-chart');
    if (!host) return;
    const todayIso = businessDateIso();
    const occurrences = financeOccurrences();
    const reserveFloor = Number(S.settings.reserveFloor) || 0;
    const points = Array.from({ length: 28 }, (_, index) => {
      const date = addIsoDays(todayIso, index);
      const forecast = forecastTimeline({
        openingBalance: Number(S.balance) || 0,
        startDate: todayIso,
        endDateExclusive: addIsoDays(date, 1),
        occurrences,
        floor: reserveFloor,
        includeOverdueBills: true,
      });
      return { date, value: forecast.endingBalance };
    });
    const fullForecast = forecastTimeline({
      openingBalance: Number(S.balance) || 0,
      startDate: todayIso,
      endDateExclusive: addIsoDays(todayIso, 28),
      occurrences,
      floor: reserveFloor,
      includeOverdueBills: true,
    });

    const values = points.map(point => point.value);
    const rawMin = Math.min(0, reserveFloor, fullForecast.minimumBalance, ...values);
    const rawMax = Math.max(0, reserveFloor, ...values);
    const span = Math.max(rawMax - rawMin, 100);
    const min = rawMin - span * 0.14;
    const max = rawMax + span * 0.14;
    const width = 900;
    const height = 278;
    const pad = { top: 22, right: 20, bottom: 42, left: 58 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const x = index => pad.left + (index / (points.length - 1)) * plotWidth;
    const y = value => pad.top + ((max - value) / (max - min || 1)) * plotHeight;
    const line = points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
    const grid = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      const value = max - ratio * (max - min);
      const py = pad.top + ratio * plotHeight;
      return `<line x1="${pad.left}" y1="${py}" x2="${width - pad.right}" y2="${py}" class="chart-grid-line" />
        <text x="${pad.left - 9}" y="${py + 4}" text-anchor="end" class="chart-y-label">${compactMoney(value)}</text>`;
    }).join('');
    const labels = points.map((point, index) => [0, 7, 14, 21, 27].includes(index)
      ? `<text x="${x(index)}" y="${height - 13}" text-anchor="middle" class="chart-x-label">${fmtShort(parseIso(point.date))}</text>`
      : '').join('');
    const dots = points.map((point, index) => `<circle cx="${x(index)}" cy="${y(point.value)}" r="${[0, 7, 14, 21, 27].includes(index) ? 4 : 2}" class="chart-dot${point.value < 0 ? ' is-negative' : ''}"><title>${fmtLong(parseIso(point.date))}: ${money(point.value)}</title></circle>`).join('');
    const minimumIndex = Math.max(0, Math.min(points.length - 1,
      diffDays(parseIso(todayIso), parseIso(fullForecast.minimumDate))));
    const minimumX = x(minimumIndex);
    const minimumEndpoint = points[minimumIndex].value;
    const minimumStem = Math.abs(minimumEndpoint - fullForecast.minimumBalance) >= 0.005
      ? `<line x1="${minimumX}" y1="${y(minimumEndpoint)}" x2="${minimumX}" y2="${y(fullForecast.minimumBalance)}" stroke="var(--danger)" stroke-width="2" stroke-dasharray="3 3" />`
      : '';
    const minimumMarker = `${minimumStem}<circle cx="${minimumX}" cy="${y(fullForecast.minimumBalance)}" r="5" class="chart-dot${fullForecast.minimumBalance < 0 ? ' is-negative' : ''}"><title>Lowest balance ${fmtLong(parseIso(fullForecast.minimumDate))}: ${money(fullForecast.minimumBalance)} (includes bill-before-income timing)</title></circle>`;
    const nextCycleOffset = diffDays(parseIso(todayIso), parseIso(nextCycle.startDate));
    const divider = nextCycleOffset >= 0 && nextCycleOffset < points.length
      ? `<line x1="${x(nextCycleOffset)}" y1="${pad.top}" x2="${x(nextCycleOffset)}" y2="${pad.top + plotHeight}" class="chart-week-divider" />
         <text x="${x(nextCycleOffset) + 8}" y="${pad.top + 12}" class="chart-week-label">NEXT PAY CYCLE</text>`
      : '';
    const zeroLine = `<line x1="${pad.left}" y1="${y(0)}" x2="${width - pad.right}" y2="${y(0)}" class="forecast-zero-line" />`;
    const reserveLine = reserveFloor > 0
      ? `<line x1="${pad.left}" y1="${y(reserveFloor)}" x2="${width - pad.right}" y2="${y(reserveFloor)}" class="forecast-reserve-line" />
         <text x="${width - pad.right - 4}" y="${y(reserveFloor) - 6}" text-anchor="end" class="chart-week-label">RESERVE ${compactMoney(reserveFloor)}</text>`
      : '';
    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-label="Projected balance for the next 28 days">
      ${grid}${zeroLine}${reserveLine}${divider}
      <path d="${line}" class="chart-line" />
      ${dots}${minimumMarker}${labels}
    </svg>`;
    $('#budget-forecast-range').textContent = `${fmtShort(parseIso(todayIso))} – ${fmtShort(parseIso(points.at(-1).date))}`;
    $('#budget-forecast-caption').textContent = `Lowest ${money(fullForecast.minimumBalance)} on ${fmtLong(parseIso(fullForecast.minimumDate))} · projected day 28 ${money(points.at(-1).value)}.`;
  }

  function renderMealsStrip() {
    const todayIso = businessDateIso();
    const { start, end } = weekRange(parseIso(todayIso), mealsWeekOffset);
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

  function activeListItems() {
    const activeListIds = new Set(S.lists.map(list => list.id));
    return S.listItems.filter(item => activeListIds.has(item.listId));
  }

  function listItemsFor(listId) {
    return activeListItems()
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

  function occurrenceBaseAmount(occurrence) {
    if (occurrence.sourceKind === 'income_source') {
      return S.finance.incomeSources.find(source => source.id === occurrence.sourceId)?.defaultAmount ?? occurrence.amount;
    }
    if (occurrence.sourceKind === 'bill_template' || occurrence.sourceKind === 'one_time_bill') {
      return Number(S.bills.find(bill => bill.id === occurrence.sourceId)?.amount ?? occurrence.amount) || 0;
    }
    if (occurrence.sourceKind === 'one_time_income') {
      return Number(S.oneTimePayments.find(payment => payment.id === occurrence.sourceId)?.amount ?? occurrence.amount) || 0;
    }
    return occurrence.amount;
  }

  function occurrenceTagHtml(occurrence) {
    if (occurrence.type === 'bill') return occurrence.autodraft
      ? '<span class="tag autodraft">Autodraft</span>'
      : '<span class="tag">Bill</span>';
    const slug = S.finance.incomeSources?.find(source => source.id === occurrence.sourceId)?.slug;
    if (slug === 'salary' || occurrence.label === 'Salary') return '<span class="tag wife">Salary</span>';
    if (slug === 'payday' || occurrence.label === 'Payday') return '<span class="tag payday">Payday</span>';
    if (slug === 'instapay' || occurrence.label === 'Instapay') return '<span class="tag instapay">Instapay</span>';
    return '<span class="tag payment">One-time</span>';
  }

  function buildOccurrenceCashflow(tbody, openingBalance, occurrences, todayIso, interactive) {
    tbody.innerHTML = '';
    let running = Number(openingBalance) || 0;
    const rows = occurrences
      .map(occurrence => ({
        ...occurrence,
        effectiveDate: occurrence.type === 'bill' && occurrence.status === 'planned' && occurrence.date < todayIso
          ? todayIso
          : occurrence.date,
      }))
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)
        || (a.type === b.type ? 0 : a.type === 'bill' ? -1 : 1)
        || a.date.localeCompare(b.date));

    rows.forEach(occurrence => {
      const settled = occurrence.status === 'settled';
      const skipped = occurrence.status === 'skipped';
      const lateIncome = occurrence.type === 'income' && occurrence.status === 'planned' && occurrence.date < todayIso;
      const overdueBill = occurrence.type === 'bill' && occurrence.status === 'planned' && occurrence.date < todayIso;
      const affectsRunning = occurrence.status === 'planned' && !lateIncome;
      if (affectsRunning) running += occurrence.type === 'income' ? occurrence.amount : -occurrence.amount;
      const displayAmount = occurrence.actualAmount ?? occurrence.amount;
      const baseAmount = occurrenceBaseAmount(occurrence);
      const statusText = settled
        ? 'reflected in bank'
        : skipped ? 'skipped · not included'
        : overdueBill ? 'overdue · still committed'
        : lateIncome ? 'late · excluded until confirmed'
        : 'planned';
      const flags = [
        occurrence.adjusted ? 'Adjusted' : '',
        occurrence.inferred ? 'Estimated history' : '',
      ].filter(Boolean).join(' · ');
      const isOneTime = ['one_time_bill', 'one_time_income'].includes(occurrence.sourceKind);
      const editButton = occurrence.status !== 'settled' && !skipped
        ? `<button type="button" class="flow-remove occurrence-edit" data-occurrence-id="${esc(occurrence.id)}" title="Edit this occurrence">Edit</button>`
        : '';
      const removeButton = occurrence.status !== 'settled' && isOneTime
        ? `<button type="button" class="flow-remove occurrence-remove" data-occurrence-id="${esc(occurrence.id)}" title="Permanently delete this one-time item">Remove</button>`
        : '';
      const skipButton = S.finance.available
        && ['planned', 'skipped'].includes(occurrence.status)
        ? `<button type="button" class="flow-remove occurrence-skip" data-occurrence-id="${esc(occurrence.id)}" title="${skipped ? 'Put this occurrence back into the plan' : 'Exclude this occurrence without marking it paid'}">${skipped ? 'Restore' : 'Skip'}</button>`
        : '';
      const checkbox = interactive && !skipped
        ? `<input type="checkbox" class="occurrence-status-check" data-occurrence-id="${esc(occurrence.id)}" ${settled ? 'checked' : ''} title="${settled ? 'Mark as not reflected in bank' : 'Mark as reflected in bank'}" />`
        : '';
      const amountCell = interactive && !skipped
        ? `<td class="amt ${occurrence.type === 'income' ? 'pos' : 'neg'} occurrence-amount-editable" data-occurrence-id="${esc(occurrence.id)}" data-base="${baseAmount}" title="Tap to adjust this occurrence">${occurrence.type === 'income' ? '+' : '−'}${money(displayAmount)}</td>`
        : `<td class="amt ${occurrence.type === 'income' ? 'pos' : 'neg'}">${occurrence.type === 'income' ? '+' : '−'}${money(displayAmount)}</td>`;
      const runningCell = affectsRunning
        ? `<td class="running ${running >= 0 ? 'pos' : 'neg'}">${money(running)}</td>`
        : '<td class="running" style="color:var(--muted)">—</td>';
      const tr = document.createElement('tr');
      if (settled) tr.classList.add('row-paid');
      if (skipped) tr.classList.add('row-skipped');
      tr.dataset.occurrenceId = occurrence.id;
      tr.innerHTML = `
        <td>
          <div class="flow-row-name">${checkbox}${occurrenceTagHtml(occurrence)} <span>${esc(occurrence.label)}</span>${editButton}${skipButton}${removeButton}</div>
          <div class="row-meta">${fmtLong(parseIso(occurrence.date))} · ${statusText}${flags ? ` · ${flags}` : ''}</div>
        </td>
        ${amountCell}
        ${runningCell}`;
      tbody.appendChild(tr);
    });
    return running;
  }

  function renderUpcomingBillsSummary(occurrences, cycle, nextCycle, todayIso) {
    const host = document.getElementById('upcoming-bills-summary');
    if (!host) return;
    const upcoming = occurrences
      .filter(item => item.type === 'bill' && item.status !== 'skipped')
      .filter(item => (item.status === 'planned' || item.date >= todayIso) && item.date < nextCycle.endDateExclusive)
      .sort((a, b) => {
        const aOverdue = a.status === 'planned' && a.date < todayIso ? 0 : 1;
        const bOverdue = b.status === 'planned' && b.date < todayIso ? 0 : 1;
        return aOverdue - bOverdue || a.date.localeCompare(b.date);
      })
      .slice(0, 8);

    if (!upcoming.length) {
      host.innerHTML = '<div class="upcoming-empty">No open commitments through the next payday cycle.</div>';
      return;
    }

    host.innerHTML = upcoming.map(occurrence => {
      const settled = occurrence.status === 'settled';
      const overdue = occurrence.status === 'planned' && occurrence.date < todayIso;
      const period = overdue ? 'Overdue' : occurrence.date < cycle.endDateExclusive ? 'This cycle' : 'Next cycle';
      const baseAmount = occurrenceBaseAmount(occurrence);
      return `<div class="upcoming-bill-row${settled ? ' is-paid' : ''}" data-occurrence-id="${esc(occurrence.id)}">
        <label class="upcoming-check" title="${settled ? 'Mark as not reflected' : 'Mark as reflected in bank'}">
          <input type="checkbox" class="occurrence-status-check" data-occurrence-id="${esc(occurrence.id)}" ${settled ? 'checked' : ''} />
          <span></span>
        </label>
        <div class="upcoming-bill-copy">
          <strong>${esc(occurrence.label || 'Unnamed bill')}</strong>
          <small>${fmtShort(parseIso(occurrence.date))} · ${period}${occurrence.autodraft ? ' · Autodraft' : ''}${occurrence.adjusted ? ' · Adjusted' : ''}${occurrence.inferred ? ' · Estimated' : ''}</small>
        </div>
        <label class="upcoming-amount">
          <span>$</span>
          <input type="number" class="occurrence-amount-input${occurrence.adjusted ? ' is-overridden' : ''}" data-occurrence-id="${esc(occurrence.id)}" data-base="${baseAmount}" min="0" step="0.01" value="${occurrence.actualAmount ?? occurrence.amount}" aria-label="Amount for ${esc(occurrence.label || 'bill')} on ${fmtShort(parseIso(occurrence.date))}" />
        </label>
      </div>`;
    }).join('');
  }

  function renderDashboard() {
    renderSnapshots();
    renderCashflowChart();

    const todayIso = businessDateIso();
    const today = parseIso(todayIso);
    const cycle = activePaydayCycle();
    const nextCycle = nextPaydayCycle(cycle);
    const occurrences = financeOccurrences();
    const reserveFloor = Number(S.settings.reserveFloor) || 0;
    const bankBalance = Number(S.balance) || 0;
    const currentPosition = currentCashPosition({
      bankBalance,
      asOfDate: todayIso,
      cycleEndDateExclusive: cycle.endDateExclusive,
      occurrences,
      floor: reserveFloor,
    });

    $('#cycle-label').textContent = cycle.fallback ? 'Current budget window' : 'Current payday cycle';
    $('#cycle-range').textContent = `${fmtLong(parseIso(cycle.startDate))} → ${fmtLong(parseIso(cycle.endDateInclusive))}`;
    if (!$('#balance-save').classList.contains('is-dirty')) $('#input-balance').value = bankBalance;
    $('#reserve-floor').value = reserveFloor;
    const snapshotTime = S.finance.balanceSnapshot?.asOf ? new Date(S.finance.balanceSnapshot.asOf) : null;
    $('#balance-as-of').textContent = snapshotTime && !Number.isNaN(snapshotTime.valueOf())
      ? `Last updated ${snapshotTime.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      : 'Legacy balance · update once to timestamp it';

    const currentScheduled = occurrences.filter(item => item.status !== 'skipped' && dateInRange(item.date, cycle.startDate, cycle.endDateExclusive));
    const currentIncome = currentScheduled.filter(item => item.type === 'income');
    const currentBills = currentScheduled.filter(item => item.type === 'bill');
    const incomeScheduled = currentIncome.reduce((sum, item) => sum + item.amount, 0);
    const billsScheduled = currentBills.reduce((sum, item) => sum + item.amount, 0);
    const incomeReceived = currentIncome.filter(item => item.status === 'settled').reduce((sum, item) => sum + (item.actualAmount ?? item.amount), 0);
    const billsCleared = currentBills.filter(item => item.status === 'settled').reduce((sum, item) => sum + (item.actualAmount ?? item.amount), 0);
    const pendingIncome = currentIncome.filter(item => item.status === 'planned' && item.date >= todayIso);
    const lateIncome = currentIncome.filter(item => item.status === 'planned' && item.date < todayIso);
    const openBills = occurrences.filter(item => item.type === 'bill' && item.status === 'planned' && item.date < cycle.endDateExclusive);

    $('#period-income').textContent = money(incomeScheduled);
    $('#period-bills-total').textContent = money(billsScheduled);
    $('#hero-income-pending').textContent = money(currentPosition.incomeRemaining);
    $('#hero-bills-left').textContent = money(currentPosition.commitmentsRemaining);
    $('#hero-safe').textContent = money(currentPosition.uncommitted);

    const renderBullets = (id, lines) => {
      const element = $(`#${id}`);
      if (element) element.innerHTML = lines.map(line => `<div>• ${line}</div>`).join('');
    };
    renderBullets('hero-income-sub', [
      `${pendingIncome.length} deposit${pendingIncome.length === 1 ? '' : 's'} still coming`,
      ...(lateIncome.length ? [`${lateIncome.length} late deposit${lateIncome.length === 1 ? '' : 's'} excluded`] : []),
    ]);
    renderBullets('hero-bills-sub', [
      `${openBills.length} commitment${openBills.length === 1 ? '' : 's'} still open`,
      ...(currentPosition.overdueCount ? [`${currentPosition.overdueCount} overdue · ${money(currentPosition.overdueCommitments)}`] : []),
    ]);
    renderBullets('hero-safe-sub', [
      `Lowest forecast ${money(currentPosition.forecastFloor)}`,
      `on ${fmtShort(parseIso(currentPosition.forecastFloorDate))}`,
    ]);

    const incomeProgress = incomeScheduled > 0 ? Math.min(100, Math.max(0, incomeReceived / incomeScheduled * 100)) : 0;
    const billsProgress = billsScheduled > 0 ? Math.min(100, Math.max(0, billsCleared / billsScheduled * 100)) : 100;
    $('#budget-income-bar').style.width = `${incomeProgress}%`;
    $('#budget-bills-bar').style.width = `${billsProgress}%`;

    const heroCard = $('#hero-safe-card');
    const status = $('#budget-status');
    heroCard.classList.remove('safe', 'warn', 'danger');
    if (currentPosition.forecastFloor < 0) {
      heroCard.classList.add('danger');
      status.textContent = `Short by ${money(Math.abs(currentPosition.forecastFloor))}`;
      status.className = 'finance-status danger';
    } else if (currentPosition.forecastFloor < reserveFloor) {
      heroCard.classList.add('warn');
      status.textContent = 'Below reserve';
      status.className = 'finance-status warn';
    } else {
      heroCard.classList.add('safe');
      status.textContent = 'Covered';
      status.className = 'finance-status safe';
    }

    const headsUp = nextCycleHeadsUp({
      openingBalance: currentPosition.uncommitted,
      cycleStartDate: nextCycle.startDate,
      cycleEndDateExclusive: nextCycle.endDateExclusive,
      occurrences,
      floor: reserveFloor,
    });
    $('#next-cycle-range').textContent = `${fmtLong(parseIso(nextCycle.startDate))} → ${fmtLong(parseIso(nextCycle.endDateInclusive))}`;
    $('#next-cycle-start').textContent = money(headsUp.openingBalance);
    $('#next-cycle-income').textContent = money(headsUp.expectedIncome);
    $('#next-cycle-bills').textContent = money(headsUp.committedBills);
    $('#next-cycle-net').textContent = money(headsUp.netChange);
    $('#next-cycle-end').textContent = money(headsUp.projectedEnding);
    $('#next-cycle-floor').textContent = `${money(headsUp.projectedMinimum)} · ${fmtShort(parseIso(headsUp.projectedMinimumDate))}`;
    const reserveEl = $('#next-cycle-reserve');
    if (reserveEl) reserveEl.textContent = money(headsUp.requiredCarry);
    const nextStatus = $('#next-cycle-status');
    const nextCard = $('#next-cycle-card');
    nextCard.classList.remove('safe', 'warn', 'danger');
    if (headsUp.projectedMinimum < 0) {
      nextCard.classList.add('danger');
      nextStatus.textContent = `Short ${money(Math.abs(headsUp.projectedMinimum))}`;
      nextStatus.className = 'finance-status danger';
    } else if (!headsUp.covered) {
      nextCard.classList.add('warn');
      nextStatus.textContent = `Reserve ${money(headsUp.shortfallToRequiredCarry)}`;
      nextStatus.className = 'finance-status warn';
    } else {
      nextCard.classList.add('safe');
      nextStatus.textContent = 'Covered';
      nextStatus.className = 'finance-status safe';
    }

    renderUpcomingBillsSummary(occurrences, cycle, nextCycle, todayIso);

    const currentRows = occurrences.filter(item => (
      dateInRange(item.date, cycle.startDate, cycle.endDateExclusive)
      || (item.type === 'bill' && item.status === 'planned' && item.date < cycle.startDate)
    ));
    $('#flow-title').innerHTML = `<span>Current cycle · editable</span><span class="card-subtitle">${fmtShort(parseIso(cycle.startDate))} – ${fmtShort(parseIso(cycle.endDateInclusive))} · overdue commitments carry forward</span>`;
    const endingBalance = buildOccurrenceCashflow($('#flow-tbody'), bankBalance, currentRows, todayIso, true);
    const currentEndRow = document.createElement('tr');
    currentEndRow.className = 'flow-summary-row';
    currentEndRow.innerHTML = `<td><div class="row-name">Cycle end</div><div class="row-meta">${fmtLong(parseIso(cycle.endDateInclusive))}</div></td><td></td><td class="running ${endingBalance >= 0 ? 'pos' : 'neg'}">${money(endingBalance)}</td>`;
    $('#flow-tbody').appendChild(currentEndRow);

    const nextRows = occurrences.filter(item => dateInRange(item.date, nextCycle.startDate, nextCycle.endDateExclusive));
    $('#lookahead-title').innerHTML = `<span>Next cycle · editable</span><span class="card-subtitle">${fmtShort(parseIso(nextCycle.startDate))} – ${fmtShort(parseIso(nextCycle.endDateInclusive))} · full payday to full payday</span>`;
    const nextEnding = buildOccurrenceCashflow($('#lookahead-tbody'), currentPosition.uncommitted, nextRows, todayIso, true);
    const nextEndRow = document.createElement('tr');
    nextEndRow.className = 'flow-summary-row';
    nextEndRow.innerHTML = `<td><div class="row-name">Projected cycle end</div><div class="row-meta">Starting carry plus next-cycle activity</div></td><td></td><td class="running ${nextEnding >= 0 ? 'pos' : 'neg'}">${money(nextEnding)}</td>`;
    $('#lookahead-tbody').appendChild(nextEndRow);

    const currentDefault = dateInRange(todayIso, cycle.startDate, cycle.endDateExclusive) ? todayIso : cycle.startDate;
    [['qa-date-cur', currentDefault, cycle], ['payment-date-cur', currentDefault, cycle], ['qa-date-nxt', nextCycle.startDate, nextCycle], ['payment-date-nxt', nextCycle.startDate, nextCycle]].forEach(([id, value, range]) => {
      const input = $(`#${id}`);
      if (!input) return;
      input.value = input.value || value;
      input.min = range.startDate;
      input.max = range.endDateInclusive;
    });

    renderBudgetForecast(cycle, nextCycle);
  }

  function tagHtml(kind) {
    if(kind==='wife')     return '<span class="tag wife">Salary</span>';
    if(kind==='payday')   return '<span class="tag payday">Payday</span>';
    if(kind==='payment')  return '<span class="tag payment">One-time</span>';
    return '<span class="tag instapay">Instapay</span>';
  }

  function categoryLabel(key) {
    return CATS.find(category => category.key === key)?.label
      || (key === 'uncategorized' ? 'Uncategorized' : key.replaceAll('_', ' '));
  }

  function renderMonthlyReport() {
    const occurrences = financeOccurrences();
    const summary = summarizeCalendarMonth(selectedMonthId, occurrences);
    const start = parseIso(summary.startDate);
    const endInclusive = parseIso(addIsoDays(summary.endDateExclusive, -1));
    const selectedOccurrences = occurrences.filter(item => dateInRange(item.date, summary.startDate, summary.endDateExclusive));
    const selectedBills = selectedOccurrences.filter(item => item.type === 'bill').sort((a, b) => a.date.localeCompare(b.date));
    const recurringBills = selectedBills.filter(item => item.sourceKind !== 'one_time_bill');
    const oneTimeBills = selectedBills.filter(item => item.sourceKind === 'one_time_bill' && item.status !== 'skipped');
    const openRecurring = recurringBills.filter(item => item.status === 'planned');
    const openOneTime = oneTimeBills.filter(item => item.status === 'planned');
    const inferredCount = selectedOccurrences.filter(item => item.inferred).length;
    const monthName = start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    $('#month-report-label').textContent = monthName;
    $('#month-report-range').textContent = `${fmtShort(start)} – ${fmtShort(endInclusive)}`;
    $('#month-income').textContent = money(summary.incomeScheduled);
    $('#month-bills').textContent = money(summary.recurringBillsScheduled);
    $('#month-margin').textContent = money(summary.incomeScheduled - summary.recurringBillsScheduled);
    $('#month-bills-due').textContent = money(summary.billsRemaining);
    $('#month-income-detail').textContent = `${summary.counts.income} scheduled deposit${summary.counts.income === 1 ? '' : 's'}`;
    $('#month-bills-detail').textContent = `${summary.counts.recurringBills} recurring commitment${summary.counts.recurringBills === 1 ? '' : 's'}${summary.counts.oneTimeBills ? ` · one-time ${money(summary.oneTimeBillsScheduled)} separate` : ''}`;
    $('#month-margin-detail').textContent = 'Scheduled income minus recurring commitments';
    $('#month-bills-due-detail').textContent = `${openRecurring.length} recurring + ${openOneTime.length} one-time not yet reflected`;
    $('#month-income-received').textContent = money(summary.incomeReceived);
    $('#month-income-total').textContent = money(summary.incomeScheduled);
    $('#month-bills-cleared').textContent = money(summary.recurringBillsSettled);
    $('#month-bills-total').textContent = money(summary.recurringBillsScheduled);
    $('#month-income-progress').style.width = `${summary.incomeScheduled > 0 ? Math.min(100, summary.incomeReceived / summary.incomeScheduled * 100) : 0}%`;
    $('#month-bills-progress').style.width = `${summary.recurringBillsScheduled > 0 ? Math.min(100, summary.recurringBillsSettled / summary.recurringBillsScheduled * 100) : 100}%`;

    const reportStatus = $('#month-report-status');
    const currentMonth = businessDateIso().slice(0, 7);
    reportStatus.textContent = inferredCount
      ? `${inferredCount} estimated`
      : selectedMonthId > currentMonth ? 'Forecast' : selectedMonthId === currentMonth ? 'Current month' : 'Recorded';
    reportStatus.className = `finance-status ${inferredCount ? 'warn' : 'neutral'}`;

    const categoryHost = $('#month-category-breakdown');
    const categories = Object.entries(summary.recurringCategories).sort((a, b) => b[1] - a[1]);
    if (!categories.length) {
      categoryHost.innerHTML = '<div class="monthly-report-empty">No commitments are scheduled for this month.</div>';
    } else {
      const total = Math.max(1, categories.reduce((sum, [, amount]) => sum + amount, 0));
      categoryHost.innerHTML = categories.map(([key, amount]) => `
        <div class="month-category-row">
          <span class="month-category-copy">${esc(categoryLabel(key))}</span>
          <i class="month-category-track"><b class="month-category-fill" style="width:${Math.max(2, amount / total * 100)}%"></b></i>
          <strong class="month-category-amount">${money(amount)}</strong>
        </div>`).join('');
    }

    const billsHost = $('#month-bill-occurrences');
    const occurrenceStatus = $('#month-occurrence-status');
    occurrenceStatus.textContent = `${selectedBills.length} bill${selectedBills.length === 1 ? '' : 's'}`;
    if (!selectedBills.length) {
      billsHost.innerHTML = '<div class="monthly-report-empty">No bills are dated in this month.</div>';
      return;
    }
    billsHost.innerHTML = selectedBills.map(occurrence => {
      const settled = occurrence.status === 'settled';
      const skipped = occurrence.status === 'skipped';
      const skipEligible = S.finance.available
        && ['planned', 'skipped'].includes(occurrence.status)
        && occurrence.sourceKind !== 'one_time_bill';
      const baseAmount = occurrenceBaseAmount(occurrence);
      const statusText = skipped ? 'Skipped · not included' : settled ? 'Reflected' : occurrence.date < businessDateIso() ? 'Overdue' : 'Still due';
      const statusControl = skipped
        ? (skipEligible
          ? `<button type="button" class="flow-remove occurrence-skip" data-occurrence-id="${esc(occurrence.id)}">Restore</button>`
          : '<span class="month-skipped-label">Removed</span>')
        : `<div class="month-occurrence-actions"><label class="month-occurrence-check" title="${settled ? 'Mark as not reflected' : 'Mark as reflected in bank'}">
            <input type="checkbox" class="occurrence-status-check" data-occurrence-id="${esc(occurrence.id)}" ${settled ? 'checked' : ''} />
            <span></span>
          </label>${skipEligible ? `<button type="button" class="flow-remove occurrence-skip" data-occurrence-id="${esc(occurrence.id)}">Skip</button>` : ''}</div>`;
      const amountControl = skipped
        ? `<div class="month-occurrence-amount">${money(occurrence.actualAmount ?? occurrence.amount)}</div>`
        : `<label class="month-occurrence-amount"><span>$</span><input type="number" class="occurrence-amount-input${occurrence.adjusted ? ' is-overridden' : ''}" data-occurrence-id="${esc(occurrence.id)}" data-base="${baseAmount}" min="0" step="0.01" value="${occurrence.actualAmount ?? occurrence.amount}" aria-label="Amount for ${esc(occurrence.label)}" /></label>`;
      return `<article class="month-occurrence-row${settled ? ' is-cleared' : ''}${skipped ? ' is-skipped' : ''}" data-occurrence-id="${esc(occurrence.id)}">
        ${statusControl}
        <div class="month-occurrence-copy">
          <strong>${esc(occurrence.label)}</strong>
          <small>${fmtLong(parseIso(occurrence.date))} · ${occurrence.sourceKind === 'one_time_bill' ? 'One-time · ' : ''}${statusText}${occurrence.autodraft ? ' · Autodraft' : ''}${occurrence.inferred ? ' · Estimated' : ''}</small>
        </div>
        ${amountControl}
      </article>`;
    }).join('');
  }

  function renderBillsTable() {
    const tb=$('#bills-tbody');
    tb.innerHTML='';
    let rMonthly=0, rWeekly=0;

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
    const openOneTimeTotal = financeOccurrences()
      .filter(item => item.type === 'bill' && item.sourceKind === 'one_time_bill' && item.status === 'planned')
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    $('#total-onetime').textContent = money(openOneTimeTotal);
    $('#total-all').textContent     = money(rMonthly + rWeekly);
    renderCategoryTotals();
    renderMonthlyReport();
  }

  function renderSchedule() {
    const cfg=S.settings;
    $('#sched-wife-line').textContent=`${money(cfg.wifeWeekly)} every Tuesday`;
    const list=$('#list-schedule');
    list.innerHTML='';
    if (S.finance.available) {
      const todayIso = businessDateIso();
      const futureEnd = addIsoDays(todayIso, 36);
      const income = financeOccurrences().filter(item => item.type === 'income');
      const upcoming = income.filter(item => item.date >= todayIso && item.date < futureEnd).sort((a, b) => a.date.localeCompare(b.date));
      const recent = income.filter(item => item.date < todayIso).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
      const appendGroup = (title, rows) => {
        const heading = document.createElement('li');
        heading.className = 'schedule-group-label';
        heading.textContent = title;
        list.appendChild(heading);
        if (!rows.length) {
          const empty = document.createElement('li');
          empty.className = 'schedule-empty';
          empty.textContent = 'Nothing recorded here yet.';
          list.appendChild(empty);
          return;
        }
        rows.forEach(event => {
          const li = document.createElement('li');
          const settled = event.status === 'settled';
          const skipped = event.status === 'skipped';
          li.classList.toggle('is-settled', settled);
          li.classList.toggle('is-skipped', skipped);
          li.innerHTML = `
            <span class="ev-left">
              <span class="ev-labels">${occurrenceTagHtml(event)} ${event.adjusted ? '<span class="tag">± adjusted</span>' : ''}${['planned', 'skipped'].includes(event.status) ? `<button type="button" class="flow-remove occurrence-skip" data-occurrence-id="${esc(event.id)}">${skipped ? 'Restore' : 'Skip'}</button>` : ''}</span>
              <span class="ev-meta">${fmtLong(parseIso(event.date))} · ${skipped ? 'skipped · not included' : settled ? 'received' : event.date < todayIso ? 'late · excluded' : 'scheduled'}${event.inferred ? ' · estimated' : ''}</span>
            </span>
            <span class="ev-amt">${money(event.actualAmount ?? event.amount)}</span>`;
          list.appendChild(li);
        });
      };
      appendGroup('Upcoming · next 35 days', upcoming);
      appendGroup('Recent deposits', recent);
      return;
    }

    const from=businessTodayDate(), to=addDays(from,35);
    const events = allIncome(cfg,S.incomeOverrides,S.oneTimePayments,from,to).filter(e=>e.date>=sod(from));
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
    if (!$('#balance-save').classList.contains('is-dirty')) $('#input-balance').value=S.balance;
  }

  function refresh() { syncBalance(); syncSettings(); renderWeek(); renderDashboard(); renderBillsTable(); renderSchedule(); }

  function refreshFinanceViews() {
    syncBalance();
    syncSettings();
    renderDashboard();
    renderBillsTable();
    renderSchedule();
  }

  $$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>showView(btn.dataset.view)));
  $$('.sub-nav-btn').forEach(btn=>btn.addEventListener('click',()=>showSubView(btn.dataset.subview)));

  function shiftedMonthId(monthId, offset) {
    const date = parseIso(`${monthId}-01`);
    date.setMonth(date.getMonth() + offset);
    return toIso(date).slice(0, 7);
  }

  async function showReportMonth(monthId) {
    selectedMonthId = monthId;
    const range = calendarMonthRange(monthId);
    await ensureFinanceRange(range.startDate, range.endDateExclusive);
    renderMonthlyReport();
  }

  $('#month-prev').addEventListener('click', () => showReportMonth(shiftedMonthId(selectedMonthId, -1)));
  $('#month-next').addEventListener('click', () => showReportMonth(shiftedMonthId(selectedMonthId, 1)));
  $('#month-current').addEventListener('click', () => showReportMonth(businessDateIso().slice(0, 7)));

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

  $('#input-balance').addEventListener('input', () => {
    $('#balance-save').classList.add('is-dirty');
    $('#balance-as-of').textContent = 'Unsaved balance change';
  });
  $('#balance-save').addEventListener('click', async () => {
    const button = $('#balance-save');
    const amount = Number($('#input-balance').value);
    if (!Number.isFinite(amount)) {
      $('#input-balance').focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Updating…';
    try {
      S.balance = amount;
      const asOf = new Date().toISOString();
      if (S.finance.available) {
        S.finance.balanceSnapshot = await saveBalanceSnapshot(
          supabase,
          S.finance.household.id,
          amount,
          asOf,
          session.user.id,
        );
      }
      await saveSettingsPatch({ balance: amount });
      button.classList.remove('is-dirty');
      renderWeek();
      renderDashboard();
      renderMonthlyReport();
      if (financeReloadPending) scheduleFinanceReload();
    } catch (error) {
      console.error('save bank balance error:', error);
      alert('The bank balance did not save. Please try again.');
    } finally {
      button.disabled = false;
      button.textContent = 'Update bank balance';
    }
  });

  $('#reserve-floor').addEventListener('change', async event => {
    const value = Math.max(0, Number(event.target.value) || 0);
    S.settings.reserveFloor = value;
    try {
      await Promise.all([
        saveSettingsPatch({ reserve_floor: value }),
        S.finance.available ? saveReserveFloor(supabase, S.finance.household.id, value) : Promise.resolve(),
      ]);
      if (S.finance.available) S.finance.household.reserveFloor = value;
      renderWeek();
      renderDashboard();
    } catch (error) {
      console.error('save reserve floor error:', error);
      alert('The reserve floor did not save. Please try again.');
    }
  });

  const incomeDefaults = {
    '#set-wife': { stateKey: 'wifeWeekly', column: 'wife_weekly_income', slug: 'salary' },
    '#set-payday': { stateKey: 'husbandPayday', column: 'payday_default', slug: 'payday' },
    '#set-instapay': { stateKey: 'husbandInstapay', column: 'instapay_default', slug: 'instapay' },
  };
  Object.entries(incomeDefaults).forEach(([selector, config]) => {
    $(selector).addEventListener('change', async event => {
      const input = event.target;
      const previousValue = S.settings[config.stateKey];
      const value = Math.max(0, Number(input.value) || 0);
      S.settings[config.stateKey] = value;
      input.disabled = true;
      let authoritativeSourceUpdated = false;
      try {
        if (S.finance.available) {
          const source = sourceForSlug(config.slug);
          if (source) {
            await saveIncomeSourceDefault(supabase, S.finance.household.id, config.slug, value);
            authoritativeSourceUpdated = true;
            source.defaultAmount = value;
            const syncFuture = () => updateFutureSourceAmounts(supabase, {
                householdId: S.finance.household.id,
                direction: 'income',
                sourceKind: 'income_source',
                sourceId: source.id,
                fromDate: businessDateIso(),
                amount: value,
                label: source.name,
              });
            try {
              await syncFuture();
            } catch (firstError) {
              console.warn('Retrying income default sync:', firstError);
              await syncFuture();
            }
            S.finance.occurrences = await reloadOccurrences(supabase, S.finance.household.id);
          }
        }
        try {
          await saveSettingsPatch({ [config.column]: value });
        } catch (firstError) {
          console.warn('Retrying legacy income setting sync:', firstError);
          await saveSettingsPatch({ [config.column]: value });
        }
        renderDashboard();
        renderMonthlyReport();
        renderSchedule();
      } catch (error) {
        console.error('save income default error:', error);
        if (!authoritativeSourceUpdated) {
          S.settings[config.stateKey] = previousValue;
          input.value = previousValue;
        } else {
          showFinanceIssue('An income default was saved but its future schedule needs another sync. Reopen the app to retry.');
        }
        alert('The income default did not save. Please try again.');
      } finally {
        input.disabled = false;
      }
    });
  });

  function occurrenceById(id) {
    return financeOccurrences().find(item => item.id === id);
  }

  async function handleOccurrenceStatusChange(event) {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement) || !checkbox.classList.contains('occurrence-status-check')) return;
    const occurrence = occurrenceById(checkbox.dataset.occurrenceId);
    if (!occurrence) return;
    checkbox.disabled = true;
    try {
      await setOccurrenceSettled(occurrence, checkbox.checked);
      renderWeek();
      renderDashboard();
      renderMonthlyReport();
      renderSchedule();
    } catch (error) {
      console.error('save occurrence status error:', error);
      checkbox.checked = !checkbox.checked;
      alert('That status did not save. Please try again.');
    } finally {
      checkbox.disabled = false;
    }
  }

  function handleOccurrenceAmountClick(event) {
    const cell = event.target.closest('.occurrence-amount-editable');
    if (!cell || cell.querySelector('input')) return;
    const occurrence = occurrenceById(cell.dataset.occurrenceId);
    if (!occurrence) return;
    const baseAmount = Number(cell.dataset.base) || 0;
    const previousValue = occurrence.actualAmount ?? occurrence.amount;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = `bill-amt-edit${occurrence.adjusted ? ' is-overridden' : ''}`;
    input.value = previousValue;
    input.min = '0';
    input.step = '0.01';
    input.title = `Default: ${money(baseAmount)} — use the default amount to reset`;
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    let handled = false;
    const commit = async () => {
      if (handled) return;
      handled = true;
      const value = input.value.trim() === '' ? baseAmount : Number(input.value);
      try {
        await setOccurrenceAmount(occurrence, value, baseAmount);
        renderDashboard();
        renderMonthlyReport();
        renderSchedule();
      } catch (error) {
        console.error('save occurrence amount error:', error);
        alert('That amount did not save. Please try again.');
        renderDashboard();
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', keyEvent => {
      if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); input.blur(); }
      if (keyEvent.key === 'Escape') { handled = true; renderDashboard(); }
    });
  }

  async function handleOccurrenceInputCommit(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('occurrence-amount-input')) return;
    const occurrence = occurrenceById(input.dataset.occurrenceId);
    if (!occurrence) return;
    const baseAmount = Number(input.dataset.base) || 0;
    const value = input.value.trim() === '' ? baseAmount : Number(input.value);
    try {
      await setOccurrenceAmount(occurrence, value, baseAmount);
      renderWeek();
      renderDashboard();
      renderMonthlyReport();
      renderSchedule();
    } catch (error) {
      console.error('save occurrence amount error:', error);
      alert('That amount did not save. Please try again.');
    }
  }

  const occurrenceHosts = [$('#flow-tbody'), $('#lookahead-tbody'), $('#upcoming-bills-summary'), $('#month-bill-occurrences')];
  occurrenceHosts.forEach(host => {
    host.addEventListener('change', handleOccurrenceStatusChange);
    host.addEventListener('click', handleOccurrenceAmountClick);
    host.addEventListener('focusout', handleOccurrenceInputCommit);
    host.addEventListener('keydown', event => {
      if (event.target.classList.contains('occurrence-amount-input') && event.key === 'Enter') {
        event.preventDefault();
        event.target.blur();
      }
    });
  });

  // Quick-add toggle / cancel / submit
  document.addEventListener('click', async ev=>{
    const editButton = ev.target.closest('.occurrence-edit');
    if (editButton) {
      const occurrence = occurrenceById(editButton.dataset.occurrenceId);
      if (occurrence?.status === 'planned') openOccurrenceEditor(occurrence);
      return;
    }

    const skipButton = ev.target.closest('.occurrence-skip');
    if (skipButton) {
      if (!S.finance.available) return;
      const occurrence = occurrenceById(skipButton.dataset.occurrenceId);
      if (!occurrence || !['planned', 'skipped'].includes(occurrence.status)) return;
      skipButton.disabled = true;
      try {
        const nextStatus = occurrence.status === 'skipped' ? 'planned' : 'skipped';
        const updated = await patchOccurrence(supabase, occurrence.id, {
          status: nextStatus,
          actualAmount: null,
          settledAt: null,
          inferred: false,
        });
        replaceFinanceOccurrence(updated);
        renderWeek();
        renderDashboard();
        renderMonthlyReport();
        renderSchedule();
      } catch (error) {
        console.error('skip occurrence error:', error);
        alert('That item could not be updated. Please try again.');
      } finally {
        skipButton.disabled = false;
      }
      return;
    }

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
      const submitButton = ev.target;
      const half = submitButton.dataset.half; // 'cur' or 'nxt'
      const name = document.getElementById(`qa-name-${half}`)?.value.trim();
      const amountInput = document.getElementById(`qa-amt-${half}`);
      const date = document.getElementById(`qa-date-${half}`)?.value;
      if (!name || !date) { alert('Fill in name and date.'); return; }
      const amt = amountInput ? validatedAmountInput(amountInput) : null;
      if (amt == null) return;
      submitButton.disabled = true;
      const bill = {
        id: `bill-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        name, amount: amt, recurring: false, recurKind: 'monthly', recurDay: 1, dueDate: date,
        autodraft: false, category: '',
      };
      S.bills.push(bill);
      let sourceSaved = false;
      try {
        await saveOneTimeBill(bill, () => { sourceSaved = true; });
      } catch (error) {
        S.bills = S.bills.filter(item => item.id !== bill.id);
        console.error('add one-time bill error:', error);
        if (sourceSaved) {
          try {
            await removeBillRow(bill);
          } catch (cleanupError) {
            console.error('one-time bill rollback error:', cleanupError);
            showFinanceIssue('A failed one-time bill may need cleanup. Reopen the app before relying on the forecast.');
          }
        }
        alert('The one-time bill did not save. Please try again.');
        return;
      } finally {
        submitButton.disabled = false;
      }
      // Clear form and hide
      document.getElementById(`qa-name-${half}`).value = '';
      document.getElementById(`qa-amt-${half}`).value  = '';
      document.getElementById(`qa-form-${half}`).style.display = 'none';
      renderDashboard();
      renderBillsTable();
      return;
    }

    if (ev.target.classList.contains('payment-submit')) {
      const submitButton = ev.target;
      const half = submitButton.dataset.half;
      const name = document.getElementById(`payment-name-${half}`)?.value.trim();
      const amountInput = document.getElementById(`payment-amt-${half}`);
      const date = document.getElementById(`payment-date-${half}`)?.value;
      if (!name || !date) { alert('Fill in name and date.'); return; }
      const amt = amountInput ? validatedAmountInput(amountInput) : null;
      if (amt == null) return;
      submitButton.disabled = true;
      const payment = {
        id: `payment-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        name,
        amount: amt,
        paymentDate: date,
      };
      S.oneTimePayments.push(payment);
      let sourceSaved = false;
      try {
        await saveOneTimePayment(payment, () => { sourceSaved = true; });
      } catch (error) {
        S.oneTimePayments = S.oneTimePayments.filter(item => item.id !== payment.id);
        console.error('add one-time payment error:', error);
        if (sourceSaved) {
          try {
            await removePaymentRow(payment.id);
          } catch (cleanupError) {
            console.error('one-time payment rollback error:', cleanupError);
            showFinanceIssue('A failed one-time payment may need cleanup. Reopen the app before relying on the forecast.');
          }
        }
        alert('The one-time payment did not save. Please try again.');
        return;
      } finally {
        submitButton.disabled = false;
      }
      document.getElementById(`payment-name-${half}`).value = '';
      document.getElementById(`payment-amt-${half}`).value = '';
      document.getElementById(`payment-form-${half}`).style.display = 'none';
      renderDashboard();
      renderSchedule();
      return;
    }

    const removeOccurrenceButton = ev.target.closest('.occurrence-remove');
    if (removeOccurrenceButton) {
      const occurrence = occurrenceById(removeOccurrenceButton.dataset.occurrenceId);
      if (!occurrence || occurrence.status === 'settled') return;
      if (!confirm(`Permanently remove “${occurrence.label || 'this one-time item'}”?`)) return;
      removeOccurrenceButton.disabled = true;
      try {
        await removeOneTimeOccurrence(occurrence);
        renderDashboard();
        renderMonthlyReport();
        renderBillsTable();
        renderSchedule();
      } catch (error) {
        console.error('remove one-time occurrence error:', error);
        alert('That one-time item could not be removed. Please try again.');
      } finally {
        removeOccurrenceButton.disabled = false;
      }
      return;
    }
  });

  $('#btn-add-bill').addEventListener('click', async event=>{
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    const bill = {id:`bill-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:'',amount:'',recurring:false,recurKind:'monthly',recurDay:1,dueDate:'',autodraft:false,category:''};
    S.bills.push(bill);
    try {
      await saveBillRow(bill);
      renderBillsTable();
      renderDashboard();
    } catch (error) {
      S.bills = S.bills.filter(item => item.id !== bill.id);
      console.error('add bill error:', error);
      alert('The new bill row did not save. Please try again.');
    } finally {
      button.disabled = false;
    }
  });

  const billSaveStates = new Map();
  const deletingBillIds = new Set();
  function queueBillSave(billId, scheduleChanged) {
    let state = billSaveStates.get(billId);
    if (!state) {
      state = { dirty: false, scheduleChanged: false, promise: null };
      billSaveStates.set(billId, state);
    }
    state.dirty = true;
    state.scheduleChanged ||= scheduleChanged;

    if (!state.promise) {
      state.promise = (async () => {
        try {
          while (state.dirty) {
            state.dirty = false;
            const needsScheduleRebuild = state.scheduleChanged;
            state.scheduleChanged = false;
            if (deletingBillIds.has(billId)) return;
            const current = S.bills.find(item => item.id === billId);
            if (!current) return;
            const snapshot = clone(current);
            await saveBillRow(snapshot);
            try {
              await syncBillOccurrences(snapshot, needsScheduleRebuild);
            } catch (firstError) {
              console.warn('Retrying bill occurrence sync:', firstError);
              await syncBillOccurrences(snapshot, needsScheduleRebuild);
            }
          }
        } finally {
          state.promise = null;
          if (!state.dirty) {
            billSaveStates.delete(billId);
            queueMicrotask(flushDeferredFinanceReload);
          } else {
            queueMicrotask(() => queueBillSave(billId, state.scheduleChanged).catch(error => {
              console.error('queued bill retry error:', error);
              showFinanceIssue('A queued bill change could not synchronize. Reopen the app to retry.');
            }));
          }
        }
      })();
    }
    return state.promise;
  }

  async function handleBills(ev) {
    const el=ev.target; if(!el?.dataset?.f) return;
    const tr=el.closest('tr'); if(!tr) return;
    const bill=S.bills.find(b=>b.id===tr.dataset.id); if(!bill) return;
    if (deletingBillIds.has(bill.id)) return;
    const f=el.dataset.f;
    let scheduleChanged = ['dueDate', 'recurDay', 'recurKind', 'recurring'].includes(f);
    if(f==='name')      bill.name=el.value;
    if(f==='amount') {
      const previousAmount = Number(bill.amount);
      const restoreValue = Number.isFinite(previousAmount) && previousAmount >= 0
        ? bill.amount ?? ''
        : 0;
      const amount = validatedAmountInput(el, { allowZero: true, restoreValue });
      if (amount == null) return;
      bill.amount = amount;
    }
    if(f==='dueDate')   bill.dueDate=el.value;
    if(f==='recurDay')  bill.recurDay=Number(el.value)||0;
    if(f==='category')  bill.category=el.value;
    if(f==='autodraft') bill.autodraft=el.checked;
    if(f==='recurring') {
      bill.recurring=el.checked;
      if(el.checked) {
        bill.dueDate='';
        if (!bill.recurKind) bill.recurKind = 'monthly';
      }
    }
    if(f==='recurKind') {
      bill.recurKind = el.value;
      // Reset day to a sensible default when the cadence changes
      if (el.value === 'weekly' && (bill.recurDay > 6 || bill.recurDay < 0)) bill.recurDay = 1;
      if (el.value === 'monthly' && (bill.recurDay < 1 || bill.recurDay > 31)) bill.recurDay = 1;
    }
    try {
      await queueBillSave(bill.id, scheduleChanged);
      if (!document.activeElement?.closest?.('#bills-tbody')) renderBillsTable();
      renderDashboard();
    } catch (error) {
      console.error('save bill error:', error);
      showFinanceIssue('A bill change was only partly synchronized. Reopen the app to retry before relying on the forecast.');
      alert('That bill change did not save. Reload the app before editing it again.');
    }
  }
  $('#bills-tbody').addEventListener('change',handleBills);

  $('#bills-tbody').addEventListener('click', async ev=>{
    const t=ev.target;
    if(!(t instanceof HTMLElement)||t.dataset.del==null) return;
    const tr=t.closest('tr'); if(!tr) return;
    const bill = S.bills.find(item => item.id === tr.dataset.id);
    if (!bill || !confirm(`Remove “${bill.name || 'this bill'}” from future plans? Its recorded history will stay intact.`)) return;
    deletingBillIds.add(bill.id);
    try {
      const pendingSave = billSaveStates.get(bill.id)?.promise;
      if (pendingSave) {
        try { await pendingSave; }
        catch (pendingError) { console.warn('Finishing removal after a queued bill save failed:', pendingError); }
      }
      if (S.finance.available) {
        await Promise.all(['bill_template', 'one_time_bill'].map(sourceKind => skipFutureSourceOccurrences(supabase, {
          householdId: S.finance.household.id,
          direction: 'expense',
          sourceKind,
          sourceId: bill.id,
          fromDate: businessDateIso(),
        })));
        S.finance.occurrences = await reloadOccurrences(supabase, S.finance.household.id);
      }
      await removeBillRow(bill);
      S.bills=S.bills.filter(item=>item.id!==bill.id);
      renderBillsTable();
      renderDashboard();
    } catch (error) {
      console.error('remove bill error:', error);
      alert('That bill could not be removed. Please try again.');
    } finally {
      deletingBillIds.delete(bill.id);
    }
  });

  $('#btn-export').addEventListener('click',()=>{
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(S,null,2)],{type:'application/json'}));
    a.download=`ghp-reference-snapshot-${businessDateIso()}.json`;
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

  const importInput = $('#input-import');
  const importLabel = $('#legacy-import-label');
  const importNote = $('#data-import-note');
  const legacyImportBlocked = S.finance.available || !!S.finance.issue;
  if (legacyImportBlocked) {
    importInput.disabled = true;
    importLabel.classList.add('is-disabled');
    importLabel.setAttribute('aria-disabled', 'true');
    importLabel.title = 'Legacy settings import is unavailable while dated financial history is active or could not be verified.';
    importNote.textContent = S.finance.available
      ? 'Legacy import is disabled because this household now uses dated financial history. The exported JSON is a reference snapshot, not a restorable ledger backup.'
      : 'Legacy import is disabled while household data could not be fully verified. Reopen the app after the load issue is resolved; no import is safe in this state.';
  }

  importInput.addEventListener('change',ev=>{
    if (legacyImportBlocked) {
      alert('Legacy import is disabled because household data is using dated financial history or could not be fully verified. No data was changed.');
      ev.target.value = '';
      return;
    }
    const f=ev.target.files?.[0]; if(!f) return;
    const r=new FileReader();
    r.onload=async ()=>{
      try {
        const p=JSON.parse(String(r.result));
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('Expected a JSON object');
        const importedSettings = p.settings && typeof p.settings === 'object' && !Array.isArray(p.settings)
          ? p.settings
          : {};
        const finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
        const objectOr = (value, fallback) => value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;

        const nextSettings = {
          ...S.settings,
          wifeWeekly: Math.max(0, finiteOr(importedSettings.wifeWeekly, S.settings.wifeWeekly)),
          husbandPayday: Math.max(0, finiteOr(importedSettings.husbandPayday, S.settings.husbandPayday)),
          husbandInstapay: Math.max(0, finiteOr(importedSettings.husbandInstapay, S.settings.husbandInstapay)),
          anchorPaydayThursday: typeof importedSettings.anchorPaydayThursday === 'string'
            ? importedSettings.anchorPaydayThursday
            : S.settings.anchorPaydayThursday,
          reserveFloor: Math.max(0, finiteOr(importedSettings.reserveFloor, S.settings.reserveFloor)),
        };
        const nextBalance = finiteOr(p.balance, S.balance);
        const nextIncomeOverrides = objectOr(p.incomeOverrides, S.incomeOverrides);
        const nextPaidBills = objectOr(p.paidBills, S.paidBills);
        const nextUnpaidBills = objectOr(p.unpaidBills, S.unpaidBills);
        const nextBillOverrides = objectOr(p.billOverrides, S.billOverrides);
        const nextClearedIncome = objectOr(p.clearedIncome, S.clearedIncome);

        await saveSettingsPatch({
          wife_weekly_income: nextSettings.wifeWeekly,
          payday_default: nextSettings.husbandPayday,
          instapay_default: nextSettings.husbandInstapay,
          anchor_thursday: nextSettings.anchorPaydayThursday,
          reserve_floor: nextSettings.reserveFloor,
          balance: nextBalance,
          income_overrides: nextIncomeOverrides,
          paid_bills: nextPaidBills,
          unpaid_bills: nextUnpaidBills,
          bill_overrides: nextBillOverrides,
          cleared_income: nextClearedIncome,
        });
        S.settings = nextSettings;
        S.balance = nextBalance;
        S.incomeOverrides = nextIncomeOverrides;
        S.paidBills = nextPaidBills;
        S.unpaidBills = nextUnpaidBills;
        S.billOverrides = nextBillOverrides;
        S.clearedIncome = nextClearedIncome;
        refresh();
        alert('Legacy settings imported. Bills, planning data, and dated financial history were left unchanged.');
      } catch { alert('Could not import — check the file.'); }
      ev.target.value='';
    };
    r.readAsText(f);
  });

  syncThemeButton();
  updateAmbientClock();
  loadWeather();
  setInterval(updateAmbientClock, 30000);

  try {
    await initializeFinanceLedger();
  } catch (error) {
    console.error('initialize finance ledger error:', error);
    showFinanceIssue('Some scheduled finance history could not load. Figures may be incomplete; retry by reopening the app.');
  }
  setupFinanceRealtime();

  try {
    refresh();
    if (S.finance.issue) showFinanceIssue(S.finance.issue);
  } catch(err) {
    showFinanceIssue(`Failed to start: ${err?.message||String(err)}`);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/budgetapp/sw.js', { type: 'module' }).catch(()=>{});
  }



})();
