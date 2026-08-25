# Financial history foundation

Status: **prepared locally; not applied to the hosted Supabase project**.

The migration in `migrations/20260825022937_add_financial_history_foundation.sql`
is additive. It does not rename, remove, or overwrite any existing financial
value. The legacy client may continue using `settings`, `bills`, and
`one_time_payments` while the application is moved to targeted writes.

## Public contract

The new public tables are:

- `households`: shared financial preferences, the Nevada, Missouri household
  timezone, payday anchor, cycle length, and optional reserve floor.
- `household_members`: authenticated users allowed to access a household.
- `income_sources`: effective-dated recurring income defaults.
- `cashflow_occurrences`: durable dated expectations and settlements.
- `balance_snapshots`: append-only bank-balance observations.

The occurrence source contract is intentionally stable:

| `source_kind` | `source_id` |
| --- | --- |
| `income_source` | `income_sources.id` as text |
| `bill_template` | existing recurring `bills.id` |
| `one_time_bill` | existing one-time `bills.id` |
| `one_time_income` | existing `one_time_payments.id` |

Every source ID is non-null. The named unique constraint
`cashflow_occurrences_source_date_key` covers household, direction, source kind,
source ID, and scheduled date, making materialization/upserts idempotent.

Amounts are exact `numeric(12,2)` values with database checks rejecting negative
expectations/defaults and PostgreSQL's non-finite numeric values. Scheduled dates
are `date`; settlement and audit timestamps are `timestamptz`. An
occurrence-level edit sets `is_adjusted = true`, so later default/template
changes update only future, planned, non-adjusted rows.

## What the migration backfills

When the legacy tables exist, the migration safely creates:

1. The stable all-zero household used by the existing shared settings row.
2. Memberships for the two currently allowlisted Auth users, but only when
   those users exist in `auth.users`.
3. Salary, Payday, and Instapay income-source defaults from `settings`, using
   the stable client slugs `salary`, `payday`, and `instapay`.
4. One balance snapshot from the current saved balance.
5. Directly knowable one-time income and one-time bill occurrences.
6. A shared-household tag on legacy bills/payments plus nullable soft-delete
   markers: `bills.archived_at`, `one_time_payments.archived_at`,
   `meals.deleted_at`, `shared_lists.archived_at`, and
   `shared_list_items.deleted_at`. Existing rows remain active (`NULL`); no
   source, meal, list, or item is deleted.

The cutover searches dated legacy override/status keys for evidence of recurring
history, materializes no more than the prior 24 months of inferred recurring
income/bills, and extends deterministic planning through 400 household-local
days after cutover. Ancient one-time rows are still copied at their exact dates,
but cannot widen every current recurring schedule and fabricate unrelated
history. Exact dated bill amount overrides are recovered independently; other
legacy keys older than the recurring-history safety window remain untouched for
manual export/reconciliation. The cutover applies the in-window
`income_overrides`, `bill_overrides`, `cleared_income`, `paid_bills`, and
`unpaid_bills` values. This prevents activity already reflected in the migrated
bank balance from being counted a second time without risking an unbounded
migration.

The legacy behavior is retained at cutover: unmarked past income and bills are
treated as settled, except a past bill explicitly present in `unpaid_bills`
remains planned; today/future rows remain planned unless explicitly cleared or
paid early. Current-day classification uses the household timezone, never the
database server's UTC date. Only rows before that household-local cutover date
carry `is_inferred = true`, because their exact settlement timestamps and
historical defaults were not stored. Today/future rows are deterministic plans
and carry `is_inferred = false`. Review inferred rows against statements before
treating historical reports as fully reconciled.

If a removed bill template left a dated amount in `bill_overrides`, that amount
is preserved as an inferred `Deleted bill (legacy)` occurrence. Status-only keys
without a surviving source or amount remain untouched in legacy JSON because no
honest dollar amount can be reconstructed.

If the template still exists but its due day moved, the dated override is
restored under the surviving bill's real name/category/source. The occurrence
generated from today's template for the same calendar month is marked `skipped`
(or, for weekly bills, the closest unadjusted occurrence within six days is
skipped), preventing the historical month/week from being counted twice. An
explicit legacy key on that generated date takes precedence and prevents this
suppression.

The legacy `settings.reserve_floor` fallback is added conditionally with a
zero default. No existing setting value is replaced.

The legacy `bills.amount` and `one_time_payments.amount` columns receive named,
validated checks for nonnegative finite values. The migration does not repair or
coerce existing source rows; validation intentionally stops deployment if an
unexpected invalid value is found so it can be reviewed rather than silently
changed. The known hosted rows are expected to satisfy these checks.

The legacy household foreign keys are installed `NOT VALID`: they protect new
writes immediately without making deployment depend on the state of any column
from an earlier partial rollout. After the pre-deployment audit confirms there
are no orphan household IDs, validate them explicitly:

```sql
alter table public.bills validate constraint bills_household_id_fkey;
alter table public.one_time_payments
  validate constraint one_time_payments_household_id_fkey;
```

## Controlled materialization helpers

Two private materializers and one cutover reconciler are included. They are
revoked from `anon` and `authenticated`, so run them only from a reviewed
follow-up migration or a trusted SQL session.

```sql
select private.materialize_income_occurrences(
  '00000000-0000-0000-0000-000000000000'::uuid,
  date '2026-01-01',
  date '2026-12-31',
  true
);

select private.materialize_legacy_bill_occurrences(
  '00000000-0000-0000-0000-000000000000'::uuid,
  date '2026-01-01',
  date '2026-12-31',
  true
);
```

Use `true` only for reconstructed history. The helper itself marks rows inferred
and inserts them as planned; only the one-time migration cutover block maps the
legacy settled/unpaid state. Use `false` for a reviewed future planning window.
Repeating either helper call is safe because of the named unique constraint.

`private.reconcile_legacy_finance_cutover(uuid, text, date)` is invoked once by
the migration. Its explicit date parameter exists for deterministic branch and
pgTAP fixtures. Do not rerun it on production after a person has reviewed or
edited inferred rows: by design, it reapplies the legacy JSON status model.

Do not use the helpers to backfill an unlimited extra window. The migration has
already covered up to 24 months of evidenced recurring history through its
400-day planning horizon, while copying one-time rows at their exact dates.
Reconcile inferred old rows against statements before revising their amount or
status.

## Access and synchronization

All new public tables have RLS. Membership checks use a private
security-definer helper with an empty `search_path`; users can access only rows
for households to which they belong. Anonymous table access is explicitly
revoked.

`cashflow_occurrences` cannot be deleted by an authenticated client. Correct a
mistake by marking it `skipped` or updating it with an audit timestamp instead
of erasing history. `balance_snapshots` are client append-only.

Physical DELETE privilege is also explicitly revoked from browser roles on
`settings`, `bills`, `one_time_payments`, `meals`, `shared_lists`, and
`shared_list_items`. Authenticated household users retain select/insert/update;
only an administrative database role can bypass the recoverable soft-delete
workflow.

When the `supabase_realtime` publication exists, the migration conditionally
adds all five shared-finance tables plus the legacy `bills` and
`one_time_payments` source tables and the existing `meals`, `shared_lists`, and
`shared_list_items` collaboration tables when present, without duplicating
publication entries. Their existing authenticated household-allowlist RLS and
explicit grants remain the normal read/insert/update visibility boundary. The
client may then subscribe and refresh targeted shared state across both devices.
A focus/visibility refresh remains a sensible fallback.

The application must remove shared source/planning rows by setting the marker
timestamp rather than issuing DELETE. Filtered Realtime then delivers an UPDATE,
which remains within normal RLS authorization, and the client reloads only rows
whose marker is `NULL`. No table is changed to `REPLICA IDENTITY FULL`; this
avoids Supabase's limitation that [RLS is not applied to DELETE
events](https://supabase.com/docs/guides/realtime/postgres-changes#delete-events).
If one of these tables was manually configured as `FULL`, the migration resets
it to the primary-key default. Clearing the marker provides a recoverable
restore path.

## Required pre-deployment checks

1. Take a database backup and keep a current JSON export from the app.
2. Confirm the remote Postgres major version matches `config.toml`; the generated
   local config currently targets Postgres 17 and must not be assumed correct.
3. Inspect migration history with `supabase migration list` after linking, but
   do not repair or push history blindly. The legacy schema predates versioned
   migrations and currently lives in `schema.sql`.
4. Apply and test in a local/branch database first.
5. Run Supabase database and security advisors before production deployment.
6. Verify both Auth UUIDs appear in `household_members` after migration.
7. Confirm the cutover balance snapshot equals the last legacy saved balance,
   and compare planned/settled/adjusted counts with the legacy JSON keys.
8. Validate the two legacy household foreign keys after confirming there are no
   orphan IDs, using the SQL above.
9. Verify new public tables are exposed in Data API settings. Explicit grants
   are included, but API exposure and RLS are separate controls.
10. Compare the legacy and occurrence calculations for a full pay cycle before
    retiring any JSON field.
11. Confirm occurrence reads are date-ranged or paginated; the reconstructed
    backlog can exceed the Data API's common 1,000-row response cap.
12. Confirm all subscribed tables are in `supabase_realtime`, and confirm none
    of the soft-deleted source/planning tables uses replica identity `FULL`.
13. Confirm every active-row read filters the appropriate marker to `NULL`, and
    every remove action writes a timestamp instead of issuing DELETE.
14. Confirm `authenticated` has no DELETE privilege on the six legacy/shared
    tables listed above.

## Local verification

The repository now has official Supabase CLI configuration and a pgTAP test:

```text
npx supabase start
npx supabase db reset
npx supabase test db
```

Docker/Podman is required for the local stack. This workstation did not have a
container runtime available when the migration was authored. The SQL was parsed
with a PostgreSQL parser and executed against an isolated in-memory Postgres
runtime with the legacy schema, sample settings, both household Auth IDs,
one-time rows, recurring templates, status flags, overrides, a deleted-template
override, and a malformed legacy date. Those smoke tests verified cutover
reconciliation, idempotent income/bill materialization, household RLS,
anonymous denial, append-only balance grants, and settled-to-skipped state
normalization. The committed pgTAP suite still must be run in the full local
Supabase stack before any hosted deployment.
