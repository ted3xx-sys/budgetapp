import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULE_SUPERSEDED_CATEGORY,
  addIsoDays,
  amountForDate,
  billScheduleGuardIdentities,
  calendarMonthRange,
  currentCashPosition,
  forecastTimeline,
  isoDateInTimeZone,
  materializeSchedule,
  nextCycleHeadsUp,
  paydayCycleFor,
  summarizeCalendarMonth,
} from '../src/financeEngine.js';

const plannedBill = (id, date, amount, extra = {}) => ({
  id, type: 'bill', date, amount, status: 'planned', ...extra,
});
const plannedIncome = (id, date, amount, extra = {}) => ({
  id, type: 'income', date, amount, status: 'planned', ...extra,
});

test('Payday cycles cover a full 14 days and make the next Payday exclusive', () => {
  assert.deepEqual(paydayCycleFor('2026-08-24', '2026-08-13'), {
    startDate: '2026-08-13',
    endDateInclusive: '2026-08-26',
    endDateExclusive: '2026-08-27',
    nextPaydayDate: '2026-08-27',
  });
  assert.equal(paydayCycleFor('2026-08-27', '2026-08-13').startDate, '2026-08-27');
});

test('Payday cycle anchoring works backward across year boundaries', () => {
  const cycle = paydayCycleFor('2025-12-31', '2026-01-08');
  assert.equal(cycle.startDate, '2025-12-25');
  assert.equal(cycle.endDateExclusive, '2026-01-08');
});

test('Current position includes overdue prior-cycle bills and excludes late unconfirmed income', () => {
  const position = currentCashPosition({
    bankBalance: 500,
    asOfDate: '2026-08-13',
    cycleEndDateExclusive: '2026-08-27',
    occurrences: [
      plannedBill('prior-unpaid', '2026-08-10', 125),
      plannedBill('current-bill', '2026-08-20', 300),
      plannedIncome('late-income', '2026-08-11', 900),
      plannedIncome('current-income', '2026-08-18', 700),
      { ...plannedBill('settled', '2026-08-12', 100), status: 'settled' },
    ],
  });

  assert.equal(position.incomeRemaining, 700);
  assert.equal(position.commitmentsRemaining, 425);
  assert.equal(position.overdueCommitments, 125);
  assert.equal(position.overdueCount, 1);
  assert.equal(position.uncommitted, 775);
});

test('A due-today bill remains committed tomorrow until explicitly settled', () => {
  const bill = plannedBill('rent', '2026-08-20', 400);
  const today = currentCashPosition({
    bankBalance: 1000,
    asOfDate: '2026-08-20',
    cycleEndDateExclusive: '2026-08-27',
    occurrences: [bill],
  });
  const tomorrow = currentCashPosition({
    bankBalance: 1000,
    asOfDate: '2026-08-21',
    cycleEndDateExclusive: '2026-08-27',
    occurrences: [bill],
  });
  const settled = currentCashPosition({
    bankBalance: 600,
    asOfDate: '2026-08-21',
    cycleEndDateExclusive: '2026-08-27',
    occurrences: [{ ...bill, status: 'settled' }],
  });

  assert.equal(today.commitmentsRemaining, 400);
  assert.equal(tomorrow.commitmentsRemaining, 400);
  assert.equal(tomorrow.overdueCommitments, 400);
  assert.equal(settled.commitmentsRemaining, 0);
  assert.equal(settled.uncommitted, 600);
});

test('Forecast orders bills before income on the same day', () => {
  const forecast = forecastTimeline({
    openingBalance: 100,
    startDate: '2026-08-13',
    endDateExclusive: '2026-08-27',
    occurrences: [
      plannedIncome('pay', '2026-08-14', 500),
      plannedBill('draft', '2026-08-14', 250),
    ],
  });

  assert.deepEqual(forecast.timeline.map((item) => item.type), ['bill', 'income']);
  assert.equal(forecast.minimumBalance, -150);
  assert.equal(forecast.minimumDate, '2026-08-14');
  assert.equal(forecast.endingBalance, 350);
});

test('Overdue bills hit the opening day of the forecast instead of disappearing', () => {
  const forecast = forecastTimeline({
    openingBalance: 300,
    startDate: '2026-08-13',
    endDateExclusive: '2026-08-27',
    occurrences: [plannedBill('old', '2026-08-01', 175)],
  });
  assert.equal(forecast.timeline[0].overdue, true);
  assert.equal(forecast.timeline[0].effectiveDate, '2026-08-13');
  assert.equal(forecast.endingBalance, 125);
});

test('Current uncommitted and current-cycle forecast ending reconcile exactly', () => {
  const occurrences = [
    plannedIncome('a', '2026-08-18', 0.1),
    plannedIncome('b', '2026-08-19', 0.2),
    plannedBill('c', '2026-08-20', 0.15),
  ];
  const position = currentCashPosition({
    bankBalance: 1,
    asOfDate: '2026-08-13',
    cycleEndDateExclusive: '2026-08-27',
    occurrences,
  });
  const forecast = forecastTimeline({
    openingBalance: 1,
    startDate: '2026-08-13',
    endDateExclusive: '2026-08-27',
    occurrences,
  });
  assert.equal(position.uncommitted, 1.15);
  assert.equal(forecast.endingBalance, position.uncommitted);
});

test('Next-cycle heads-up calculates timing reserve, floor, and shortfall', () => {
  const occurrences = [
    plannedBill('early', '2026-08-28', 600),
    plannedIncome('pay', '2026-09-01', 1000),
    plannedBill('later', '2026-09-05', 700),
  ];
  const result = nextCycleHeadsUp({
    openingBalance: 500,
    cycleStartDate: '2026-08-27',
    cycleEndDateExclusive: '2026-09-10',
    occurrences,
    floor: 100,
  });

  assert.equal(result.expectedIncome, 1000);
  assert.equal(result.committedBills, 1300);
  assert.equal(result.requiredCarry, 700);
  assert.equal(result.shortfallToRequiredCarry, 200);
  assert.equal(result.projectedMinimum, -100);
  assert.equal(result.projectedMinimumDate, '2026-08-28');
  assert.equal(result.projectedEnding, 200);
  assert.equal(result.covered, false);
});

test('Next-cycle heads-up does not charge prior-cycle overdue items twice', () => {
  const result = nextCycleHeadsUp({
    openingBalance: 800,
    cycleStartDate: '2026-08-27',
    cycleEndDateExclusive: '2026-09-10',
    occurrences: [
      plannedBill('already-in-opening', '2026-08-20', 400),
      plannedBill('next', '2026-09-01', 300),
    ],
  });
  assert.equal(result.committedBills, 300);
  assert.equal(result.projectedEnding, 500);
});

test('Weekly schedules produce the exact five Tuesdays in a five-pay month', () => {
  const salary = materializeSchedule({
    id: 'salary',
    type: 'income',
    label: 'Salary',
    defaultAmount: 100,
    recurrence: { cadence: 'weekly', anchorDate: '2026-01-06' },
  }, '2026-03-01', '2026-04-01');

  assert.deepEqual(salary.map((item) => item.date), [
    '2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24', '2026-03-31',
  ]);
  assert.equal(summarizeCalendarMonth('2026-03', salary).incomeScheduled, 500);
});

test('A Payday cycle includes its opening Payday and excludes the next Payday', () => {
  const payday = materializeSchedule({
    id: 'payday',
    type: 'income',
    defaultAmount: 900,
    recurrence: { cadence: 'biweekly', anchorDate: '2026-08-13' },
  }, '2026-08-13', '2026-08-27');
  assert.deepEqual(payday.map((item) => item.date), ['2026-08-13']);
});

test('Monthly day 31 clamps correctly across leap and non-leap February', () => {
  const template = {
    id: 'month-end',
    type: 'bill',
    defaultAmount: 50,
    recurrence: { cadence: 'monthly', dayOfMonth: 31 },
  };
  const leap = materializeSchedule(template, '2028-01-01', '2028-04-01');
  const nonLeap = materializeSchedule(template, '2027-02-01', '2027-03-01');
  assert.deepEqual(leap.map((item) => item.date), ['2028-01-31', '2028-02-29', '2028-03-31']);
  assert.deepEqual(nonLeap.map((item) => item.date), ['2027-02-28']);
});

test('Calendar month ranges are exact and exclude the first day of the next month', () => {
  assert.deepEqual(calendarMonthRange('2026-12'), {
    startDate: '2026-12-01',
    endDateExclusive: '2027-01-01',
  });
  const summary = summarizeCalendarMonth('2026-08', [
    plannedBill('aug', '2026-08-31', 100),
    plannedBill('sep', '2026-09-01', 200),
  ]);
  assert.equal(summary.billsScheduled, 100);
  assert.equal(summary.counts.bills, 1);
});

test('Effective-dated defaults preserve history and snapshot materialized amounts', () => {
  const source = {
    id: 'salary',
    type: 'income',
    defaultAmount: 9999,
    amountHistory: [
      { effectiveFrom: '2026-01-01', amount: 100 },
      { effectiveFrom: '2026-09-01', amount: 125 },
    ],
    recurrence: { cadence: 'weekly', anchorDate: '2026-01-06' },
  };
  const august = materializeSchedule(source, '2026-08-01', '2026-09-01');
  const september = materializeSchedule(source, '2026-09-01', '2026-10-01');
  source.defaultAmount = 50000;
  source.amountHistory[0].amount = 777;

  assert.equal(amountForDate({ ...source, amountHistory: [{ effectiveFrom: '2026-09-01', amount: 125 }], defaultAmount: 100 }, '2026-08-25'), 100);
  assert.ok(august.every((item) => item.amount === 100));
  assert.ok(september.every((item) => item.amount === 125));
});

test('Monthly summary separates scheduled, settled actual, remaining, and skipped', () => {
  const summary = summarizeCalendarMonth('2026-08', [
    { ...plannedIncome('salary-1', '2026-08-04', 500), status: 'settled', actualAmount: 525 },
    plannedIncome('salary-2', '2026-08-11', 500),
    { ...plannedBill('rent', '2026-08-01', 800, { category: 'home' }), status: 'settled', actualAmount: 790 },
    plannedBill('electric', '2026-08-20', 110, { category: 'utilities' }),
    { ...plannedBill('waived', '2026-08-22', 25, { category: 'fees' }), status: 'skipped' },
  ]);

  assert.equal(summary.incomeScheduled, 1000);
  assert.equal(summary.incomeReceived, 525);
  assert.equal(summary.incomeRemaining, 500);
  assert.equal(summary.incomeForecast, 1025);
  assert.equal(summary.billsScheduled, 910);
  assert.equal(summary.billsSettled, 790);
  assert.equal(summary.billsRemaining, 110);
  assert.equal(summary.billsForecast, 900);
  assert.equal(summary.forecastMargin, 125);
  assert.deepEqual(summary.categories, { home: 790, utilities: 110 });
  assert.equal(summary.counts.skipped, 1);
});

test('Monthly summary keeps one-time activity separate from recurring commitments', () => {
  const summary = summarizeCalendarMonth('2026-08', [
    plannedBill('rent', '2026-08-01', 800, {
      category: 'home', sourceKind: 'bill_template', sourceId: 'rent',
    }),
    plannedBill('extra-open', '2026-08-20', 125, {
      category: 'extra', sourceKind: 'one_time_bill', sourceId: 'extra-open',
    }),
    {
      ...plannedBill('extra-settled', '2026-08-10', 75, {
        category: 'extra', sourceKind: 'one_time_bill', sourceId: 'extra-settled',
      }),
      status: 'settled',
      actualAmount: 70,
    },
  ]);

  assert.equal(summary.billsScheduled, 1000);
  assert.equal(summary.recurringBillsScheduled, 800);
  assert.equal(summary.recurringBillsRemaining, 800);
  assert.equal(summary.oneTimeBillsScheduled, 200);
  assert.equal(summary.oneTimeBillsSettled, 70);
  assert.equal(summary.oneTimeBillsRemaining, 125);
  assert.equal(summary.counts.recurringBills, 1);
  assert.equal(summary.counts.oneTimeBills, 2);
  assert.deepEqual(summary.recurringCategories, { home: 800 });
  assert.deepEqual(summary.oneTimeCategories, { extra: 195 });
});

test('Date arithmetic stays exact through leap day', () => {
  assert.equal(addIsoDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addIsoDays('2028-02-29', 1), '2028-03-01');
});

test('Household business dates do not follow the device across UTC midnight', () => {
  const instant = new Date('2026-08-25T02:30:00.000Z');
  assert.equal(isoDateInTimeZone(instant, 'America/Chicago'), '2026-08-24');
  assert.equal(isoDateInTimeZone(instant, 'Asia/Tokyo'), '2026-08-25');
});

test('Monthly schedule edits preserve settled and manually skipped logical periods', () => {
  const candidates = [
    plannedBill('aug-new', '2026-08-28', 100, { sourceKind: 'bill_template', sourceId: 'rent' }),
    plannedBill('sep-new', '2026-09-28', 100, { sourceKind: 'bill_template', sourceId: 'rent' }),
  ];
  const settled = {
    ...plannedBill('aug-old', '2026-08-26', 100, { sourceKind: 'bill_template', sourceId: 'rent' }),
    status: 'settled',
  };
  assert.deepEqual(billScheduleGuardIdentities({
    candidates,
    existingOccurrences: [settled],
    cadence: 'monthly',
    targetSourceKind: 'bill_template',
    sourceId: 'rent',
  }), ['bill_template|2026-08-28']);

  const manuallySkipped = { ...settled, id: 'aug-skip', status: 'skipped', category: 'home' };
  assert.deepEqual(billScheduleGuardIdentities({
    candidates,
    existingOccurrences: [manuallySkipped],
    cadence: 'monthly',
    targetSourceKind: 'bill_template',
    sourceId: 'rent',
  }), ['bill_template|2026-08-28']);
});

test('Weekly guards match protected occurrences one-to-one, including boundary candidates', () => {
  const candidates = ['2026-08-23', '2026-08-30', '2026-09-06'].map(date =>
    plannedBill(`new-${date}`, date, 25, { sourceKind: 'bill_template', sourceId: 'weekly' }),
  );
  const protectedRows = ['2026-08-22', '2026-08-29'].map((date, index) => ({
    ...plannedBill(`old-${date}`, date, 25, { sourceKind: 'bill_template', sourceId: 'weekly' }),
    status: index ? 'skipped' : 'settled',
    category: 'utilities',
  }));
  assert.deepEqual(billScheduleGuardIdentities({
    candidates,
    existingOccurrences: protectedRows,
    cadence: 'weekly',
    targetSourceKind: 'bill_template',
    sourceId: 'weekly',
  }), ['bill_template|2026-08-23', 'bill_template|2026-08-30']);
});

test('Automatically superseded guards do not suppress schedules across repeated edits', () => {
  const candidates = [
    plannedBill('new', '2026-08-29', 100, { sourceKind: 'bill_template', sourceId: 'rent' }),
  ];
  const automaticGuard = {
    ...plannedBill('old-guard', '2026-08-28', 100, {
      sourceKind: 'bill_template',
      sourceId: 'rent',
      category: SCHEDULE_SUPERSEDED_CATEGORY,
    }),
    status: 'skipped',
  };
  assert.deepEqual(billScheduleGuardIdentities({
    candidates,
    existingOccurrences: [automaticGuard],
    cadence: 'monthly',
    targetSourceKind: 'bill_template',
    sourceId: 'rent',
  }), []);
});

test('Recurring and one-time conversions preserve only the represented logical occurrence', () => {
  const oneTimeCandidate = [
    plannedBill('once', '2026-08-28', 100, { sourceKind: 'one_time_bill', sourceId: 'rent' }),
  ];
  const settledMonthly = {
    ...plannedBill('monthly', '2026-08-26', 100, { sourceKind: 'bill_template', sourceId: 'rent' }),
    status: 'settled',
  };
  assert.deepEqual(billScheduleGuardIdentities({
    candidates: oneTimeCandidate,
    existingOccurrences: [settledMonthly],
    cadence: 'monthly',
    targetSourceKind: 'one_time_bill',
    sourceId: 'rent',
  }), ['one_time_bill|2026-08-28']);

  const recurringCandidates = ['2026-08-28', '2026-09-28'].map(date =>
    plannedBill(`monthly-${date}`, date, 100, { sourceKind: 'bill_template', sourceId: 'rent' }),
  );
  const settledOneTime = {
    ...plannedBill('once-old', '2026-08-26', 100, { sourceKind: 'one_time_bill', sourceId: 'rent' }),
    status: 'settled',
  };
  assert.deepEqual(billScheduleGuardIdentities({
    candidates: recurringCandidates,
    existingOccurrences: [settledOneTime],
    cadence: 'monthly',
    targetSourceKind: 'bill_template',
    sourceId: 'rent',
  }), ['bill_template|2026-08-28']);
});

test('A guarded replacement cannot double a settled month in financial summaries', () => {
  const represented = {
    ...plannedBill('old-settled', '2026-08-26', 100, { category: 'home' }),
    status: 'settled',
    actualAmount: 100,
  };
  const automaticGuard = {
    ...plannedBill('new-guard', '2026-08-28', 100, { category: SCHEDULE_SUPERSEDED_CATEGORY }),
    status: 'skipped',
  };
  const summary = summarizeCalendarMonth('2026-08', [represented, automaticGuard]);
  assert.equal(summary.billsScheduled, 100);
  assert.equal(summary.billsSettled, 100);
  assert.equal(summary.billsRemaining, 0);
});
