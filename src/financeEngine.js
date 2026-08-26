/**
 * Pure, date-only finance calculations for Gloodt Home Planner.
 *
 * Design rules:
 * - Date ranges are half-open: [startDate, endDateExclusive).
 * - ISO dates are treated as calendar dates, never as local timestamps.
 * - Bills are ordered before income on the same day for a conservative floor.
 * - A planned bill remains committed after its due date until explicitly settled
 *   or skipped. Past-due planned income is excluded from forecasts until it is
 *   rescheduled or confirmed, so a late paycheck cannot mask a shortfall.
 * - Money is summed as integer cents and converted back to dollars at the API.
 */

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ID = /^(\d{4})-(\d{2})$/;
const OPEN_STATUSES = new Set(['planned', 'authorized']);
const VALID_STATUSES = new Set([...OPEN_STATUSES, 'settled', 'skipped']);

/** Category marker for rows suppressed by schedule reconciliation, not by a person. */
export const SCHEDULE_SUPERSEDED_CATEGORY = '__ghp_schedule_superseded__';

function dayNumber(value, label = 'date') {
  if (typeof value !== 'string') throw new TypeError(`${label} must be an ISO date string`);
  const match = ISO_DATE.exec(value);
  if (!match) throw new TypeError(`${label} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const parsed = new Date(utc);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`${label} is not a real calendar date`);
  }
  return Math.floor(utc / DAY_MS);
}

function isoFromDayNumber(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function moneyCents(value, label = 'amount', allowNegative = true) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${label} must be a finite number`);
  if (!allowNegative && numeric < 0) throw new RangeError(`${label} cannot be negative`);
  return Math.round((numeric + Number.EPSILON) * 100);
}

function dollars(cents) {
  return cents === 0 ? 0 : cents / 100;
}

function validateRange(startDate, endDateExclusive) {
  const startDay = dayNumber(startDate, 'startDate');
  const endDay = dayNumber(endDateExclusive, 'endDateExclusive');
  if (endDay <= startDay) throw new RangeError('endDateExclusive must be after startDate');
  return { startDay, endDay };
}

function occurrenceStatus(occurrence) {
  const status = occurrence.status || 'planned';
  if (!VALID_STATUSES.has(status)) {
    throw new RangeError(`Unsupported occurrence status: ${status}`);
  }
  return status;
}

function occurrenceType(occurrence) {
  if (occurrence.type !== 'bill' && occurrence.type !== 'income') {
    throw new RangeError('Occurrence type must be "bill" or "income"');
  }
  return occurrence.type;
}

function plannedCents(occurrence) {
  return moneyCents(occurrence.amount, 'occurrence amount', false);
}

function actualCents(occurrence) {
  return occurrence.actualAmount == null
    ? plannedCents(occurrence)
    : moneyCents(occurrence.actualAmount, 'occurrence actualAmount', false);
}

function isOpen(occurrence) {
  return OPEN_STATUSES.has(occurrenceStatus(occurrence));
}

/** Add a whole number of days to an ISO calendar date. */
export function addIsoDays(date, amount) {
  if (!Number.isInteger(amount)) throw new TypeError('amount must be a whole number of days');
  return isoFromDayNumber(dayNumber(date) + amount);
}

/** Resolve a real instant to the household's YYYY-MM-DD business date. */
export function isoDateInTimeZone(value = new Date(), timeZone = 'America/Chicago') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new RangeError('value must be a valid date or timestamp');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('Unable to resolve the business date');
  return `${year}-${month}-${day}`;
}

function scheduleIdentity(occurrence) {
  dayNumber(occurrence.date, 'occurrence date');
  return `${occurrence.sourceKind}|${occurrence.date}`;
}

function orderedWeeklyMatches(protectedRows, candidates) {
  const protectedSorted = [...protectedRows].sort((a, b) =>
    a.day - b.day || a.key.localeCompare(b.key) || String(a.id || '').localeCompare(String(b.id || '')),
  );
  const candidateSorted = [...candidates].sort((a, b) =>
    a.day - b.day || a.key.localeCompare(b.key),
  );
  const rows = protectedSorted.length;
  const columns = candidateSorted.length;
  const scores = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: columns + 1 }, () => ({ matches: 0, cost: 0, choice: null })),
  );

  const choose = options => options.reduce((best, option) => {
    if (!best || option.matches > best.matches) return option;
    if (option.matches < best.matches) return best;
    if (option.cost < best.cost) return option;
    if (option.cost > best.cost) return best;
    const rank = { match: 0, skipProtected: 1, skipCandidate: 2 };
    return rank[option.choice] < rank[best.choice] ? option : best;
  }, null);

  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const options = [
        { ...scores[row - 1][column], choice: 'skipProtected' },
        { ...scores[row][column - 1], choice: 'skipCandidate' },
      ];
      const distance = Math.abs(protectedSorted[row - 1].day - candidateSorted[column - 1].day);
      if (distance <= 6) {
        const diagonal = scores[row - 1][column - 1];
        options.push({ matches: diagonal.matches + 1, cost: diagonal.cost + distance, choice: 'match' });
      }
      scores[row][column] = choose(options);
    }
  }

  const matched = [];
  let row = rows;
  let column = columns;
  while (row > 0 && column > 0) {
    const choice = scores[row][column].choice;
    if (choice === 'match') {
      matched.push(candidateSorted[column - 1]);
      row -= 1;
      column -= 1;
    } else if (choice === 'skipProtected') {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return matched;
}

/**
 * Identify new bill-schedule rows that must remain suppressed because a settled
 * or manually skipped row already represents that logical monthly/weekly period.
 * Automatically superseded rows are deliberately ignored so repeated edits can
 * move the guard instead of progressively erasing the future schedule.
 */
export function billScheduleGuardIdentities({
  candidates = [],
  existingOccurrences = [],
  cadence = 'monthly',
  targetSourceKind = 'bill_template',
  sourceId,
  supersededCategory = SCHEDULE_SUPERSEDED_CATEGORY,
} = {}) {
  if (!['monthly', 'weekly'].includes(cadence)) {
    throw new RangeError('cadence must be monthly or weekly');
  }
  const resolvedSourceId = sourceId == null ? candidates[0]?.sourceId : sourceId;
  if (resolvedSourceId == null || !candidates.length) return [];

  const uniqueCandidates = new Map();
  candidates.forEach(candidate => {
    if (candidate.type !== 'bill'
      || candidate.sourceKind !== targetSourceKind
      || String(candidate.sourceId) !== String(resolvedSourceId)) return;
    const key = scheduleIdentity(candidate);
    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(key, { ...candidate, key, day: dayNumber(candidate.date) });
    }
  });
  const availableCandidates = [...uniqueCandidates.values()];
  if (!availableCandidates.length) return [];

  const protectedRows = existingOccurrences.filter(occurrence =>
    occurrence.type === 'bill'
    && String(occurrence.sourceId) === String(resolvedSourceId)
    && (occurrence.status === 'settled'
      || (occurrence.status === 'planned' && occurrence.adjusted)
      || (occurrence.status === 'skipped' && occurrence.category !== supersededCategory)),
  ).map(occurrence => ({
    ...occurrence,
    key: scheduleIdentity(occurrence),
    day: dayNumber(occurrence.date),
  }));
  if (!protectedRows.length) return [];

  const guarded = new Set();
  const usedProtected = new Set();
  const usedCandidates = new Set();

  // An exact protected row already occupies the candidate's unique database
  // identity, so materialization cannot create a second row to suppress. Mark
  // both sides consumed without guarding the row against itself.
  protectedRows.forEach((protectedRow, protectedIndex) => {
    const candidate = availableCandidates.find(item =>
      !usedCandidates.has(item.key) && item.key === protectedRow.key,
    );
    if (!candidate) return;
    usedCandidates.add(candidate.key);
    usedProtected.add(protectedIndex);
  });

  let remainingProtected = protectedRows.filter((_, index) => !usedProtected.has(index));
  let remainingCandidates = availableCandidates.filter(candidate => !usedCandidates.has(candidate.key));

  // A one-time row is the same one-time obligation even when its date is edited.
  if (targetSourceKind === 'one_time_bill') {
    const oldOneTimeIndex = remainingProtected.findIndex(row => row.sourceKind === 'one_time_bill');
    if (oldOneTimeIndex >= 0 && remainingCandidates.length) {
      guarded.add(remainingCandidates[0].key);
      remainingCandidates = remainingCandidates.slice(1);
      remainingProtected = remainingProtected.filter((_, index) => index !== oldOneTimeIndex);
    }
  }

  if (cadence === 'monthly') {
    const protectedByMonth = new Map();
    remainingProtected.forEach(row => {
      const month = row.date.slice(0, 7);
      if (!protectedByMonth.has(month)) protectedByMonth.set(month, []);
      protectedByMonth.get(month).push(row);
    });
    remainingCandidates
      .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
      .forEach(candidate => {
        const rows = protectedByMonth.get(candidate.date.slice(0, 7));
        if (!rows?.length) return;
        rows.shift();
        guarded.add(candidate.key);
      });
  } else {
    orderedWeeklyMatches(remainingProtected, remainingCandidates)
      .forEach(candidate => guarded.add(candidate.key));
  }

  return [...guarded].sort();
}

/**
 * Find the 14-day Payday-to-next-Payday cycle containing referenceDate.
 * The next Payday is the exclusive boundary and belongs to the next cycle.
 */
export function paydayCycleFor(referenceDate, paydayAnchorDate) {
  const referenceDay = dayNumber(referenceDate, 'referenceDate');
  const anchorDay = dayNumber(paydayAnchorDate, 'paydayAnchorDate');
  const startDay = referenceDay - positiveModulo(referenceDay - anchorDay, 14);
  return {
    startDate: isoFromDayNumber(startDay),
    endDateInclusive: isoFromDayNumber(startDay + 13),
    endDateExclusive: isoFromDayNumber(startDay + 14),
    nextPaydayDate: isoFromDayNumber(startDay + 14),
  };
}

/** Return the half-open range for a calendar month (YYYY-MM). */
export function calendarMonthRange(monthId) {
  const match = typeof monthId === 'string' ? MONTH_ID.exec(monthId) : null;
  if (!match) throw new TypeError('monthId must use YYYY-MM');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError('monthId has an invalid month');
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    startDate: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
    endDateExclusive: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
  };
}

/** Resolve an effective-dated default without rewriting earlier dates. */
export function amountForDate(template, date) {
  const targetDay = dayNumber(date);
  const history = Array.isArray(template.amountHistory)
    ? template.amountHistory.map((entry) => ({
        effectiveDay: dayNumber(entry.effectiveFrom, 'amountHistory.effectiveFrom'),
        amount: dollars(moneyCents(entry.amount, 'amountHistory.amount', false)),
      })).sort((a, b) => a.effectiveDay - b.effectiveDay)
    : [];

  let resolved;
  for (const entry of history) {
    if (entry.effectiveDay > targetDay) break;
    resolved = entry.amount;
  }
  if (resolved != null) return resolved;
  if (template.defaultAmount != null) {
    return dollars(moneyCents(template.defaultAmount, 'defaultAmount', false));
  }
  throw new RangeError(`No amount is effective for ${date}`);
}

function monthlyOccurrenceDays(fromDay, throughDay, dayOfMonth) {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    throw new RangeError('dayOfMonth must be between 1 and 31');
  }
  const result = [];
  const from = new Date(fromDay * DAY_MS);
  let year = from.getUTCFullYear();
  let monthIndex = from.getUTCMonth();

  while (Math.floor(Date.UTC(year, monthIndex, 1) / DAY_MS) < throughDay) {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const occurrenceDay = Math.floor(
      Date.UTC(year, monthIndex, Math.min(dayOfMonth, lastDay)) / DAY_MS,
    );
    if (occurrenceDay >= fromDay && occurrenceDay < throughDay) result.push(occurrenceDay);
    monthIndex += 1;
    if (monthIndex === 12) {
      year += 1;
      monthIndex = 0;
    }
  }
  return result;
}

/**
 * Materialize immutable amount snapshots for a recurring bill or income source.
 * Supported recurrence cadences are weekly, biweekly, and monthly.
 */
export function materializeSchedule(template, startDate, endDateExclusive) {
  const { startDay, endDay } = validateRange(startDate, endDateExclusive);
  const recurrence = template.recurrence || {};
  const cadence = recurrence.cadence;
  let days = [];

  if (cadence === 'weekly' || cadence === 'biweekly') {
    const step = cadence === 'weekly' ? 7 : 14;
    const anchorDay = dayNumber(recurrence.anchorDate, 'recurrence.anchorDate');
    const first = anchorDay + Math.ceil((startDay - anchorDay) / step) * step;
    for (let day = first; day < endDay; day += step) days.push(day);
  } else if (cadence === 'monthly') {
    days = monthlyOccurrenceDays(startDay, endDay, Number(recurrence.dayOfMonth));
  } else {
    throw new RangeError('Unsupported recurrence cadence');
  }

  const type = occurrenceType(template);
  const templateId = String(template.id || `${type}-template`);
  return days.map((day) => {
    const date = isoFromDayNumber(day);
    return Object.freeze({
      id: `${templateId}:${date}`,
      templateId,
      type,
      label: template.label || template.name || '',
      category: template.category || '',
      date,
      amount: amountForDate(template, date),
      status: 'planned',
    });
  });
}

/**
 * Materialize the durable occurrence represented by every active one-time
 * source. These rows are intentionally not range-limited: an overdue source
 * with a missing occurrence must be repaired instead of disappearing forever.
 */
export function oneTimeSourceOccurrences({ bills = [], payments = [] } = {}) {
  const validDate = value => {
    try {
      dayNumber(value, 'one-time source date');
      return true;
    } catch {
      return false;
    }
  };
  const validId = value => value != null && String(value).trim() !== '';
  const occurrences = [];

  bills.forEach(bill => {
    if (bill.recurring || !validId(bill.id) || !validDate(bill.dueDate)) return;
    occurrences.push({
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
  });

  payments.forEach(payment => {
    if (!validId(payment.id) || !validDate(payment.paymentDate)) return;
    occurrences.push({
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
      autodraft: false,
    });
  });

  return occurrences;
}

function projectionEvents({ occurrences, startDay, endDay, includeOverdueBills }) {
  const events = [];
  occurrences.forEach((occurrence, originalIndex) => {
    const type = occurrenceType(occurrence);
    if (!isOpen(occurrence)) return;
    const scheduledDay = dayNumber(occurrence.date, 'occurrence date');
    if (scheduledDay >= endDay) return;

    if (type === 'income' && scheduledDay < startDay) return;
    if (type === 'bill' && scheduledDay < startDay && !includeOverdueBills) return;

    const amount = plannedCents(occurrence);
    const effectiveDay = Math.max(startDay, scheduledDay);
    events.push({
      occurrence,
      type,
      amount,
      scheduledDay,
      effectiveDay,
      originalIndex,
    });
  });

  events.sort((a, b) =>
    a.effectiveDay - b.effectiveDay ||
    (a.type === b.type ? 0 : a.type === 'bill' ? -1 : 1) ||
    String(a.occurrence.id || '').localeCompare(String(b.occurrence.id || '')) ||
    a.originalIndex - b.originalIndex,
  );
  return events;
}

/**
 * Produce a conservative running forecast. Overdue bills are charged at the
 * opening date; overdue income is not assumed to arrive.
 */
export function forecastTimeline({
  openingBalance,
  startDate,
  endDateExclusive,
  occurrences = [],
  floor = 0,
  includeOverdueBills = true,
}) {
  const { startDay, endDay } = validateRange(startDate, endDateExclusive);
  let running = moneyCents(openingBalance, 'openingBalance');
  const floorCents = moneyCents(floor, 'floor');
  let minimum = running;
  let minimumDay = startDay;

  const timeline = projectionEvents({ occurrences, startDay, endDay, includeOverdueBills })
    .map((event) => {
      const delta = event.type === 'income' ? event.amount : -event.amount;
      running += delta;
      if (running < minimum) {
        minimum = running;
        minimumDay = event.effectiveDay;
      }
      return Object.freeze({
        id: event.occurrence.id || null,
        type: event.type,
        scheduledDate: isoFromDayNumber(event.scheduledDay),
        effectiveDate: isoFromDayNumber(event.effectiveDay),
        overdue: event.scheduledDay < startDay,
        amount: dollars(event.amount),
        delta: dollars(delta),
        runningBalance: dollars(running),
      });
    });

  return {
    openingBalance: dollars(moneyCents(openingBalance, 'openingBalance')),
    endingBalance: dollars(running),
    minimumBalance: dollars(minimum),
    minimumDate: isoFromDayNumber(minimumDay),
    floor: dollars(floorCents),
    dippedBelowFloor: minimum < floorCents,
    timeline,
  };
}

/** Current cash position through the exclusive end of the active cycle. */
export function currentCashPosition({
  bankBalance,
  asOfDate,
  cycleEndDateExclusive,
  occurrences = [],
  floor = 0,
}) {
  const asOfDay = dayNumber(asOfDate, 'asOfDate');
  const endDay = dayNumber(cycleEndDateExclusive, 'cycleEndDateExclusive');
  if (endDay <= asOfDay) throw new RangeError('cycleEndDateExclusive must be after asOfDate');

  let incomeRemaining = 0;
  let commitmentsRemaining = 0;
  let overdueCommitments = 0;
  let overdueCount = 0;

  occurrences.forEach((occurrence) => {
    const type = occurrenceType(occurrence);
    if (!isOpen(occurrence)) return;
    const date = dayNumber(occurrence.date, 'occurrence date');
    if (date >= endDay) return;
    const amount = plannedCents(occurrence);
    if (type === 'bill') {
      commitmentsRemaining += amount;
      if (date < asOfDay) {
        overdueCommitments += amount;
        overdueCount += 1;
      }
    } else if (date >= asOfDay) {
      incomeRemaining += amount;
    }
  });

  const bank = moneyCents(bankBalance, 'bankBalance');
  const uncommitted = bank + incomeRemaining - commitmentsRemaining;
  const forecast = forecastTimeline({
    openingBalance: bankBalance,
    startDate: asOfDate,
    endDateExclusive: cycleEndDateExclusive,
    occurrences,
    floor,
    includeOverdueBills: true,
  });

  return {
    bankBalance: dollars(bank),
    incomeRemaining: dollars(incomeRemaining),
    commitmentsRemaining: dollars(commitmentsRemaining),
    overdueCommitments: dollars(overdueCommitments),
    overdueCount,
    uncommitted: dollars(uncommitted),
    forecastFloor: forecast.minimumBalance,
    forecastFloorDate: forecast.minimumDate,
    dippedBelowFloor: forecast.dippedBelowFloor,
  };
}

/**
 * Quantify how much cash the next cycle needs at its opening to stay above a
 * chosen floor, and compare that requirement with the projected carry-in.
 */
export function nextCycleHeadsUp({
  openingBalance,
  cycleStartDate,
  cycleEndDateExclusive,
  occurrences = [],
  floor = 0,
}) {
  const { startDay, endDay } = validateRange(cycleStartDate, cycleEndDateExclusive);
  const inWindow = occurrences.filter((occurrence) => {
    const date = dayNumber(occurrence.date, 'occurrence date');
    return date >= startDay && date < endDay;
  });

  const zeroForecast = forecastTimeline({
    openingBalance: 0,
    startDate: cycleStartDate,
    endDateExclusive: cycleEndDateExclusive,
    occurrences: inWindow,
    floor: 0,
    includeOverdueBills: false,
  });
  const forecast = forecastTimeline({
    openingBalance,
    startDate: cycleStartDate,
    endDateExclusive: cycleEndDateExclusive,
    occurrences: inWindow,
    floor,
    includeOverdueBills: false,
  });

  const floorCents = moneyCents(floor, 'floor');
  const minimumPrefixCents = moneyCents(zeroForecast.minimumBalance, 'minimumPrefix');
  const requiredCarryCents = Math.max(0, floorCents - minimumPrefixCents);
  const openingCents = moneyCents(openingBalance, 'openingBalance');
  const shortfallCents = Math.max(0, requiredCarryCents - openingCents);

  let expectedIncome = 0;
  let committedBills = 0;
  inWindow.forEach((occurrence) => {
    if (!isOpen(occurrence)) return;
    if (occurrenceType(occurrence) === 'income') expectedIncome += plannedCents(occurrence);
    else committedBills += plannedCents(occurrence);
  });

  return {
    openingBalance: dollars(openingCents),
    expectedIncome: dollars(expectedIncome),
    committedBills: dollars(committedBills),
    netChange: dollars(expectedIncome - committedBills),
    requiredCarry: dollars(requiredCarryCents),
    headroomAfterRequiredCarry: dollars(openingCents - requiredCarryCents),
    shortfallToRequiredCarry: dollars(shortfallCents),
    projectedMinimum: forecast.minimumBalance,
    projectedMinimumDate: forecast.minimumDate,
    projectedEnding: forecast.endingBalance,
    covered: shortfallCents === 0,
  };
}

/** Exact occurrence-based totals for a selected calendar month. */
export function summarizeCalendarMonth(monthId, occurrences = []) {
  const { startDate, endDateExclusive } = calendarMonthRange(monthId);
  const { startDay, endDay } = validateRange(startDate, endDateExclusive);
  const totals = {
    incomeScheduled: 0,
    billsScheduled: 0,
    incomeReceived: 0,
    incomeRemaining: 0,
    billsSettled: 0,
    billsRemaining: 0,
    recurringBillsScheduled: 0,
    recurringBillsSettled: 0,
    recurringBillsRemaining: 0,
    oneTimeBillsScheduled: 0,
    oneTimeBillsSettled: 0,
    oneTimeBillsRemaining: 0,
  };
  const counts = { income: 0, bills: 0, recurringBills: 0, oneTimeBills: 0, skipped: 0 };
  const categoryCents = new Map();
  const recurringCategoryCents = new Map();
  const oneTimeCategoryCents = new Map();

  occurrences.forEach((occurrence) => {
    const date = dayNumber(occurrence.date, 'occurrence date');
    if (date < startDay || date >= endDay) return;
    const type = occurrenceType(occurrence);
    const status = occurrenceStatus(occurrence);
    if (status === 'skipped') {
      counts.skipped += 1;
      return;
    }

    const planned = plannedCents(occurrence);
    const actual = actualCents(occurrence);
    if (type === 'income') {
      counts.income += 1;
      totals.incomeScheduled += planned;
      if (status === 'settled') totals.incomeReceived += actual;
      else totals.incomeRemaining += planned;
    } else {
      counts.bills += 1;
      totals.billsScheduled += planned;
      const activeAmount = status === 'settled' ? actual : planned;
      if (status === 'settled') totals.billsSettled += actual;
      else totals.billsRemaining += planned;
      const category = occurrence.category || 'uncategorized';
      categoryCents.set(category, (categoryCents.get(category) || 0) + activeAmount);
      const oneTime = occurrence.sourceKind === 'one_time_bill';
      const prefix = oneTime ? 'oneTimeBills' : 'recurringBills';
      const categoryMap = oneTime ? oneTimeCategoryCents : recurringCategoryCents;
      counts[prefix] += 1;
      totals[`${prefix}Scheduled`] += planned;
      if (status === 'settled') totals[`${prefix}Settled`] += actual;
      else totals[`${prefix}Remaining`] += planned;
      categoryMap.set(category, (categoryMap.get(category) || 0) + activeAmount);
    }
  });

  const incomeForecast = totals.incomeReceived + totals.incomeRemaining;
  const billsForecast = totals.billsSettled + totals.billsRemaining;
  return {
    monthId,
    startDate,
    endDateExclusive,
    incomeScheduled: dollars(totals.incomeScheduled),
    billsScheduled: dollars(totals.billsScheduled),
    scheduledMargin: dollars(totals.incomeScheduled - totals.billsScheduled),
    incomeReceived: dollars(totals.incomeReceived),
    incomeRemaining: dollars(totals.incomeRemaining),
    incomeForecast: dollars(incomeForecast),
    billsSettled: dollars(totals.billsSettled),
    billsRemaining: dollars(totals.billsRemaining),
    billsForecast: dollars(billsForecast),
    recurringBillsScheduled: dollars(totals.recurringBillsScheduled),
    recurringBillsSettled: dollars(totals.recurringBillsSettled),
    recurringBillsRemaining: dollars(totals.recurringBillsRemaining),
    oneTimeBillsScheduled: dollars(totals.oneTimeBillsScheduled),
    oneTimeBillsSettled: dollars(totals.oneTimeBillsSettled),
    oneTimeBillsRemaining: dollars(totals.oneTimeBillsRemaining),
    forecastMargin: dollars(incomeForecast - billsForecast),
    counts,
    categories: Object.fromEntries(
      [...categoryCents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, dollars(value)]),
    ),
    recurringCategories: Object.fromEntries(
      [...recurringCategoryCents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, dollars(value)]),
    ),
    oneTimeCategories: Object.fromEntries(
      [...oneTimeCategoryCents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, dollars(value)]),
    ),
  };
}
