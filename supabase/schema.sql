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

-- ── Row Level Security ───────────────────────────────────────
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills    ENABLE ROW LEVEL SECURITY;

-- Drop policies if they already exist (so this script is re-runnable)
DROP POLICY IF EXISTS "personal_app_settings" ON settings;
DROP POLICY IF EXISTS "personal_app_bills"    ON bills;

-- Only allow reads/writes for the single hard-coded user ID.
-- Even with the anon key exposed, no other data can be touched.
CREATE POLICY "personal_app_settings" ON settings
  FOR ALL TO anon
  USING  (user_id = '00000000-0000-0000-0000-000000000000')
  WITH CHECK (user_id = '00000000-0000-0000-0000-000000000000');

CREATE POLICY "personal_app_bills" ON bills
  FOR ALL TO anon
  USING  (user_id = '00000000-0000-0000-0000-000000000000')
  WITH CHECK (user_id = '00000000-0000-0000-0000-000000000000');
