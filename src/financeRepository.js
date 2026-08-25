const MISSING_SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);
const OCCURRENCE_PAGE_SIZE = 500;

function throwIfError(error) {
  if (error) throw error;
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function financeSchemaUnavailable(error) {
  if (!error) return false;
  return MISSING_SCHEMA_CODES.has(error.code) || /could not find|does not exist/i.test(error.message || '');
}

export function occurrenceFromRow(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    type: row.direction === 'expense' ? 'bill' : 'income',
    direction: row.direction,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    date: row.scheduled_on,
    label: row.label || '',
    category: row.category || '',
    amount: numberOrZero(row.expected_amount),
    actualAmount: row.actual_amount == null ? null : numberOrZero(row.actual_amount),
    status: row.status || 'planned',
    settledAt: row.settled_at || null,
    inferred: !!row.is_inferred,
    adjusted: !!row.is_adjusted,
    autodraft: !!row.is_autodraft,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function occurrenceToRow(householdId, occurrence) {
  const row = {
    household_id: householdId,
    direction: occurrence.type === 'bill' || occurrence.direction === 'expense' ? 'expense' : 'income',
    source_kind: occurrence.sourceKind,
    source_id: String(occurrence.sourceId),
    scheduled_on: occurrence.date,
    label: occurrence.label || '',
    category: occurrence.category || '',
    expected_amount: numberOrZero(occurrence.amount),
    actual_amount: occurrence.actualAmount == null ? null : numberOrZero(occurrence.actualAmount),
    status: occurrence.status || 'planned',
    settled_at: occurrence.settledAt || null,
    is_inferred: !!occurrence.inferred,
    is_adjusted: !!occurrence.adjusted,
    is_autodraft: !!occurrence.autodraft,
  };
  if (occurrence.id) row.id = occurrence.id;
  return row;
}

async function fetchOccurrenceRows(supabase, householdId) {
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('cashflow_occurrences')
      .select('*')
      .eq('household_id', householdId)
      .order('scheduled_on')
      .order('id')
      .range(from, from + OCCURRENCE_PAGE_SIZE - 1);
    throwIfError(error);

    const page = data || [];
    rows.push(...page);
    if (page.length < OCCURRENCE_PAGE_SIZE) break;
    from += OCCURRENCE_PAGE_SIZE;
  }

  return rows;
}

export async function loadFinanceLedger(supabase) {
  const membershipResult = await supabase
    .from('household_members')
    .select('household_id')
    .limit(1)
    .maybeSingle();

  if (membershipResult.error) {
    if (financeSchemaUnavailable(membershipResult.error)) {
      return { available: false, reason: 'schema-missing' };
    }
    throw membershipResult.error;
  }
  if (!membershipResult.data?.household_id) {
    return { available: false, reason: 'membership-missing' };
  }

  const householdId = membershipResult.data.household_id;
  const [householdResult, sourceResult, occurrenceRows, balanceResult] = await Promise.all([
    supabase.from('households').select('*').eq('id', householdId).single(),
    supabase.from('income_sources').select('*').eq('household_id', householdId).order('slug'),
    fetchOccurrenceRows(supabase, householdId),
    supabase.from('balance_snapshots').select('*').eq('household_id', householdId).order('as_of', { ascending: false }).limit(1).maybeSingle(),
  ]);

  [householdResult, sourceResult, balanceResult].forEach(result => throwIfError(result.error));
  const household = householdResult.data;

  return {
    available: true,
    household: {
      id: household.id,
      name: household.name || 'Home',
      timezone: household.timezone || 'America/Chicago',
      paydayAnchor: household.payday_anchor,
      cycleDays: Number(household.cycle_days) || 14,
      reserveFloor: numberOrZero(household.reserve_floor),
    },
    incomeSources: (sourceResult.data || []).map(source => ({
      id: source.id,
      slug: source.slug,
      name: source.name || source.slug,
      cadence: source.cadence,
      anchorDate: source.anchor_date,
      defaultAmount: numberOrZero(source.default_amount),
      effectiveFrom: source.effective_from,
      effectiveThrough: source.effective_through,
      active: source.is_active !== false,
    })),
    occurrences: occurrenceRows.map(occurrenceFromRow),
    balanceSnapshot: balanceResult.data ? {
      id: balanceResult.data.id,
      amount: numberOrZero(balanceResult.data.amount),
      asOf: balanceResult.data.as_of,
      createdAt: balanceResult.data.created_at,
    } : null,
  };
}

export async function reloadOccurrences(supabase, householdId) {
  return (await fetchOccurrenceRows(supabase, householdId)).map(occurrenceFromRow);
}

export async function materializeOccurrences(supabase, householdId, occurrences) {
  if (!occurrences.length) return [];
  const rows = occurrences.map(occurrence => occurrenceToRow(householdId, occurrence));
  const { data, error } = await supabase
    .from('cashflow_occurrences')
    .upsert(rows, {
      onConflict: 'household_id,direction,source_kind,source_id,scheduled_on',
      ignoreDuplicates: true,
    })
    .select('*');
  throwIfError(error);
  return (data || []).map(occurrenceFromRow);
}

export async function saveOccurrence(supabase, householdId, occurrence) {
  const { data, error } = await supabase
    .from('cashflow_occurrences')
    .upsert(occurrenceToRow(householdId, occurrence), {
      onConflict: 'household_id,direction,source_kind,source_id,scheduled_on',
    })
    .select('*')
    .single();
  throwIfError(error);
  return occurrenceFromRow(data);
}

export async function patchOccurrence(supabase, id, changes) {
  const patch = {};
  if ('amount' in changes) patch.expected_amount = numberOrZero(changes.amount);
  if ('actualAmount' in changes) patch.actual_amount = changes.actualAmount == null ? null : numberOrZero(changes.actualAmount);
  if ('status' in changes) patch.status = changes.status;
  if ('settledAt' in changes) patch.settled_at = changes.settledAt;
  if ('adjusted' in changes) patch.is_adjusted = !!changes.adjusted;
  if ('inferred' in changes) patch.is_inferred = !!changes.inferred;
  if ('label' in changes) patch.label = changes.label || '';
  if ('category' in changes) patch.category = changes.category || '';
  if ('autodraft' in changes) patch.is_autodraft = !!changes.autodraft;

  const { data, error } = await supabase
    .from('cashflow_occurrences')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  throwIfError(error);
  return occurrenceFromRow(data);
}

export async function updateFutureSourceAmounts(supabase, {
  householdId,
  direction,
  sourceKind,
  sourceId,
  fromDate,
  amount,
  label,
  category,
  autodraft,
}) {
  const metadataPatch = {};
  if (label != null) metadataPatch.label = label;
  if (category != null) metadataPatch.category = category;
  if (autodraft != null) metadataPatch.is_autodraft = !!autodraft;

  if (Object.keys(metadataPatch).length) {
    const { error: metadataError } = await supabase
      .from('cashflow_occurrences')
      .update(metadataPatch)
      .eq('household_id', householdId)
      .eq('direction', direction)
      .eq('source_kind', sourceKind)
      .eq('source_id', String(sourceId))
      .eq('status', 'planned')
      .gte('scheduled_on', fromDate);
    throwIfError(metadataError);
  }

  const { error } = await supabase
    .from('cashflow_occurrences')
    .update({ expected_amount: numberOrZero(amount) })
    .eq('household_id', householdId)
    .eq('direction', direction)
    .eq('source_kind', sourceKind)
    .eq('source_id', String(sourceId))
    .eq('status', 'planned')
    .eq('is_adjusted', false)
    .gte('scheduled_on', fromDate);
  throwIfError(error);
}

export async function skipFutureSourceOccurrences(supabase, {
  householdId,
  direction,
  sourceKind,
  sourceId,
  fromDate,
}) {
  const { error } = await supabase
    .from('cashflow_occurrences')
    .update({ status: 'skipped', settled_at: null })
    .eq('household_id', householdId)
    .eq('direction', direction)
    .eq('source_kind', sourceKind)
    .eq('source_id', String(sourceId))
    .eq('status', 'planned')
    .gte('scheduled_on', fromDate);
  throwIfError(error);
}

export async function saveBalanceSnapshot(supabase, householdId, amount, asOf, createdBy) {
  const { data, error } = await supabase
    .from('balance_snapshots')
    .insert({
      household_id: householdId,
      amount: numberOrZero(amount),
      as_of: asOf,
      created_by: createdBy,
    })
    .select('*')
    .single();
  throwIfError(error);
  return {
    id: data.id,
    amount: numberOrZero(data.amount),
    asOf: data.as_of,
    createdAt: data.created_at,
  };
}

export async function saveReserveFloor(supabase, householdId, reserveFloor) {
  const { error } = await supabase
    .from('households')
    .update({ reserve_floor: numberOrZero(reserveFloor) })
    .eq('id', householdId);
  throwIfError(error);
}

export async function saveIncomeSourceDefault(supabase, householdId, slug, amount) {
  const { data, error } = await supabase
    .from('income_sources')
    .update({ default_amount: numberOrZero(amount) })
    .eq('household_id', householdId)
    .eq('slug', slug)
    .select('*')
    .single();
  throwIfError(error);
  return data;
}
