-- ============================================================
-- Gloodt Home Planner — Supabase Schema
-- Run this in the Supabase SQL Editor to set up your database.
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ============================================================

-- ── settings (one row for the whole app) ────────────────────
CREATE TABLE IF NOT EXISTS settings (
  user_id             TEXT PRIMARY KEY,
  wife_weekly_income  NUMERIC        NOT NULL DEFAULT 0,
  payday_default      NUMERIC        NOT NULL DEFAULT 0,
  instapay_default    NUMERIC        NOT NULL DEFAULT 0,
  anchor_thursday     TEXT           NOT NULL DEFAULT '',
  balance             NUMERIC        NOT NULL DEFAULT 0,
  income_overrides    JSONB          NOT NULL DEFAULT '{}',
  paid_bills          JSONB          NOT NULL DEFAULT '{}',
  unpaid_bills        JSONB          NOT NULL DEFAULT '{}',
  bill_overrides      JSONB          NOT NULL DEFAULT '{}',
  cleared_income      JSONB          NOT NULL DEFAULT '{}'
);

-- In case the table already existed without the newer columns:
ALTER TABLE settings ADD COLUMN IF NOT EXISTS balance           NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS income_overrides  JSONB   NOT NULL DEFAULT '{}';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS paid_bills        JSONB   NOT NULL DEFAULT '{}';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS unpaid_bills      JSONB   NOT NULL DEFAULT '{}';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS bill_overrides    JSONB   NOT NULL DEFAULT '{}';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS cleared_income    JSONB   NOT NULL DEFAULT '{}';

-- ── bills ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  amount       NUMERIC NOT NULL DEFAULT 0,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  due_day      INTEGER NOT NULL DEFAULT 1,
  due_date     TEXT,
  category     TEXT    NOT NULL DEFAULT '',
  is_autodraft BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE bills ADD COLUMN IF NOT EXISTS due_date TEXT;
-- Recurrence cadence: 'monthly' uses due_day as day-of-month (1-31);
--                    'weekly'  uses due_day as day-of-week  (0=Sun..6=Sat).
ALTER TABLE bills ADD COLUMN IF NOT EXISTS recur_kind TEXT NOT NULL DEFAULT 'monthly';

-- ── one-time incoming payments ──────────────────────────────
CREATE TABLE IF NOT EXISTS one_time_payments (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  amount       NUMERIC NOT NULL DEFAULT 0,
  payment_date DATE    NOT NULL
);

-- ── meals (what's for dinner each night) ─────────────────────
CREATE TABLE IF NOT EXISTS meals (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  meal_date DATE NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  notes     TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, meal_date)
);

-- ── shared shopping / to-do lists ────────────────────────────
CREATE TABLE IF NOT EXISTS shared_lists (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL,
  title      TEXT        NOT NULL DEFAULT '',
  notes      TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shared_list_items (
  id           TEXT        PRIMARY KEY,
  list_id      TEXT        NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL,
  item_text    TEXT        NOT NULL DEFAULT '',
  is_completed BOOLEAN     NOT NULL DEFAULT false,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shared_lists_user_id_idx ON shared_lists(user_id);
CREATE INDEX IF NOT EXISTS shared_list_items_user_id_idx ON shared_list_items(user_id);
CREATE INDEX IF NOT EXISTS shared_list_items_list_id_idx ON shared_list_items(list_id);

-- ── Row Level Security ───────────────────────────────────────
ALTER TABLE settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills             ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_time_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_lists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_list_items ENABLE ROW LEVEL SECURITY;

-- Drop policies if they already exist (so this script is re-runnable).
DROP POLICY IF EXISTS "personal_app_settings" ON settings;
DROP POLICY IF EXISTS "personal_app_bills"    ON bills;
DROP POLICY IF EXISTS "household_settings"    ON settings;
DROP POLICY IF EXISTS "household_bills"       ON bills;
DROP POLICY IF EXISTS "household_meals"       ON meals;
DROP POLICY IF EXISTS "household_one_time_payments" ON one_time_payments;
DROP POLICY IF EXISTS "household_shared_lists"      ON shared_lists;
DROP POLICY IF EXISTS "household_shared_list_items" ON shared_list_items;

-- Household allowlist: only these two authenticated users can read/write.
-- The anon key alone is insufficient; Supabase Auth is required.
CREATE POLICY "household_settings" ON settings
  FOR ALL TO authenticated
  USING ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

CREATE POLICY "household_bills" ON bills
  FOR ALL TO authenticated
  USING ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

CREATE POLICY "household_meals" ON meals
  FOR ALL TO authenticated
  USING ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

CREATE POLICY "household_one_time_payments" ON one_time_payments
  FOR ALL TO authenticated
  USING ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

CREATE POLICY "household_shared_lists" ON shared_lists
  FOR ALL TO authenticated
  USING ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

CREATE POLICY "household_shared_list_items" ON shared_list_items
  FOR ALL TO authenticated
  USING ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK ((select auth.uid()) IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

-- Explicit API privileges. RLS still limits rows to the household allowlist.
REVOKE ALL ON TABLE settings, bills, meals, one_time_payments, shared_lists, shared_list_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE settings, bills, meals, one_time_payments, shared_lists, shared_list_items TO authenticated;

-- The former events/shared_tasks tables and old misc/grocery/fuel settings
-- columns are not used by GHP anymore. This script intentionally does not
-- drop legacy data.
