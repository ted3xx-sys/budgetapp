import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reloadOccurrences,
  removeOneTimeOccurrence,
  saveOneTimeBill,
  saveOneTimePayment,
  updateOneTimeOccurrence,
  updateFutureSourceAmounts,
} from '../src/financeRepository.js';

function rpcOccurrenceRow({
  id = 'occurrence-1',
  direction = 'expense',
  sourceKind = 'one_time_bill',
  sourceId = 'source-1',
  date = '2026-08-28',
  label = 'One-time item',
  amount = 25,
} = {}) {
  return {
    id,
    household_id: 'household-1',
    direction,
    source_kind: sourceKind,
    source_id: sourceId,
    scheduled_on: date,
    label,
    category: '',
    expected_amount: amount,
    actual_amount: null,
    status: 'planned',
    settled_at: null,
    is_inferred: false,
    is_adjusted: false,
    is_autodraft: false,
  };
}

test('one-time bill creation uses the atomic RPC and maps its occurrence', async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push([name, args]);
      return {
        data: rpcOccurrenceRow({ sourceId: 'bill-1', label: 'Car repair', amount: 325 }),
        error: null,
      };
    },
  };

  const saved = await saveOneTimeBill(supabase, {
    householdId: 'household-1',
    userId: 'user-1',
    bill: {
      id: 'bill-1', name: 'Car repair', amount: 325, dueDate: '2026-08-28',
      category: 'auto', autodraft: false,
    },
  });

  assert.deepEqual(calls, [[
    'save_one_time_bill',
    {
      p_id: 'bill-1',
      p_user_id: 'user-1',
      p_household_id: 'household-1',
      p_name: 'Car repair',
      p_amount: 325,
      p_due_date: '2026-08-28',
      p_category: 'auto',
      p_is_autodraft: false,
    },
  ]]);
  assert.equal(saved.sourceKind, 'one_time_bill');
  assert.equal(saved.sourceId, 'bill-1');
  assert.equal(saved.amount, 325);
});

test('one-time payment creation, editing, and removal use atomic RPCs', async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'remove_one_time_occurrence') {
        return { data: { sourceKind: 'one_time_income', sourceId: 'payment-1', deletedCount: 1 }, error: null };
      }
      return {
        data: rpcOccurrenceRow({
          id: 'occurrence-payment', direction: 'income', sourceKind: 'one_time_income',
          sourceId: 'payment-1', date: args.p_payment_date || args.p_date,
          label: args.p_name, amount: args.p_amount,
        }),
        error: null,
      };
    },
  };

  const created = await saveOneTimePayment(supabase, {
    householdId: 'household-1',
    userId: 'user-1',
    payment: { id: 'payment-1', name: 'Refund', amount: 80, paymentDate: '2026-08-29' },
  });
  const edited = await updateOneTimeOccurrence(supabase, created.id, {
    label: 'Updated refund', amount: 95, date: '2026-08-30', category: '', autodraft: false,
  });
  const removed = await removeOneTimeOccurrence(supabase, created.id);

  assert.deepEqual(calls.map(([name]) => name), [
    'save_one_time_payment', 'update_one_time_occurrence', 'remove_one_time_occurrence',
  ]);
  assert.equal(edited.label, 'Updated refund');
  assert.equal(edited.date, '2026-08-30');
  assert.equal(removed.deletedCount, 1);
});

test('atomic one-time RPC errors propagate without a client-side partial fallback', async () => {
  const expected = Object.assign(new Error('transaction rejected'), { code: '42501' });
  const supabase = { rpc: async () => ({ data: null, error: expected }) };
  await assert.rejects(() => saveOneTimePayment(supabase, {
    householdId: 'household-1',
    userId: 'user-1',
    payment: { id: 'payment-1', name: 'Refund', amount: 80, paymentDate: '2026-08-29' },
  }), expected);
});

function occurrenceRow(index) {
  return {
    id: `occurrence-${String(index).padStart(4, '0')}`,
    household_id: 'household-1',
    direction: index % 2 ? 'income' : 'expense',
    source_kind: 'test_source',
    source_id: `source-${index}`,
    scheduled_on: '2026-08-24',
    label: `Row ${index}`,
    expected_amount: index / 100,
    actual_amount: null,
    status: 'planned',
    is_inferred: false,
    is_adjusted: false,
    is_autodraft: false,
  };
}

test('occurrence loading pages past the API row cap without dropping records', async () => {
  const rows = Array.from({ length: 1_205 }, (_, index) => occurrenceRow(index));
  const requestedRanges = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'cashflow_occurrences');
      const query = {
        select() { return query; },
        eq() { return query; },
        order() { return query; },
        range(from, to) {
          requestedRanges.push([from, to]);
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };

  const loaded = await reloadOccurrences(supabase, 'household-1');
  assert.equal(loaded.length, 1_205);
  assert.equal(loaded[0].id, 'occurrence-0000');
  assert.equal(loaded.at(-1).id, 'occurrence-1204');
  assert.deepEqual(requestedRanges, [[0, 499], [500, 999], [1000, 1499]]);
});

test('bill metadata reaches adjusted rows while default amount changes do not overwrite them', async () => {
  const updates = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'cashflow_occurrences');
      const operation = { patch: null, filters: [] };
      updates.push(operation);
      const query = {
        update(patch) { operation.patch = patch; return query; },
        eq(column, value) { operation.filters.push(['eq', column, value]); return query; },
        gte(column, value) {
          operation.filters.push(['gte', column, value]);
          return Promise.resolve({ error: null });
        },
      };
      return query;
    },
  };

  await updateFutureSourceAmounts(supabase, {
    householdId: 'household-1',
    direction: 'expense',
    sourceKind: 'bill_template',
    sourceId: 'bill-1',
    fromDate: '2026-08-24',
    amount: 125,
    label: 'Updated bill',
    category: 'utilities',
    autodraft: true,
  });

  assert.deepEqual(updates[0].patch, {
    label: 'Updated bill',
    category: 'utilities',
    is_autodraft: true,
  });
  assert.ok(!updates[0].filters.some(([, column]) => column === 'is_adjusted'));
  assert.deepEqual(updates[1].patch, { expected_amount: 125 });
  assert.ok(updates[1].filters.some(filter =>
    filter[0] === 'eq' && filter[1] === 'is_adjusted' && filter[2] === false));
});
