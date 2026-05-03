-- ============================================================
-- Household Budget App — Supabase Schema
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
  misc_income         NUMERIC        NOT NULL DEFAULT 0,
  misc_expense        NUMERIC        NOT NULL DEFAULT 0,
  groceries           NUMERIC        NOT NULL DEFAULT 0,
  fuel                NUMERIC        NOT NULL DEFAULT 0,
  income_overrides    JSONB          NOT NULL DEFAULT '{}',
  paid_bills          JSONB          NOT NULL DEFAULT '{}',
  unpaid_bills        JSONB          NOT NULL DEFAULT '{}',
  bill_overrides      JSONB          NOT NULL DEFAULT '{}',
  cleared_income      JSONB          NOT NULL DEFAULT '{}'
);

-- In case the table already existed without the newer columns:
ALTER TABLE settings ADD COLUMN IF NOT EXISTS balance           NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS misc_income       NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS misc_expense      NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS groceries         NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fuel              NUMERIC NOT NULL DEFAULT 0;
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

-- ── Row Level Security ───────────────────────────────────────
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills    ENABLE ROW LEVEL SECURITY;

-- Drop policies if they already exist (so this script is re-runnable)
DROP POLICY IF EXISTS "personal_app_settings" ON settings;
DROP POLICY IF EXISTS "personal_app_bills"    ON bills;
DROP POLICY IF EXISTS "household_settings"    ON settings;
DROP POLICY IF EXISTS "household_bills"       ON bills;

-- Household allowlist: only these two authenticated users can read/write.
-- The anon key alone is no longer sufficient — a valid signed-in session
-- (Supabase Auth) is required, and that session's user must be one of ours.
CREATE POLICY "household_settings" ON settings
  FOR ALL TO authenticated
  USING (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

CREATE POLICY "household_bills" ON bills
  FOR ALL TO authenticated
  USING (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

-- ── meals (what's for dinner each night) ─────────────────────
CREATE TABLE IF NOT EXISTS meals (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  meal_date DATE NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  notes     TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, meal_date)
);

-- ── events (upcoming things to remember together) ────────────
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  event_date DATE NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT ''
);

ALTER TABLE meals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "household_meals"  ON meals;
DROP POLICY IF EXISTS "household_events" ON events;

CREATE POLICY "household_meals" ON meals
  FOR ALL TO authenticated
  USING (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));

CREATE POLICY "household_events" ON events
  FOR ALL TO authenticated
  USING (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ))
  WITH CHECK (auth.uid() IN (
    'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
    '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
  ));
