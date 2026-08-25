import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reloadOccurrences,
  updateFutureSourceAmounts,
} from '../src/financeRepository.js';

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
