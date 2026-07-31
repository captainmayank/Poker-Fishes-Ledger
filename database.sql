-- ============================================================
-- POKER LEDGER MERGED - DATABASE SCHEMA
-- ============================================================
-- Fishes tables  : players, player_aliases, sessions,
--                  session_results, settlements
-- Live (Thor) tables : live_users, live_sessions,
--                      live_session_players, live_buy_ins
--
-- Run this once against your Postgres database.
-- Existing data is NOT affected — all Fishes tables use
-- CREATE TABLE IF NOT EXISTS and the live_ tables are new.
-- ============================================================

-- ============================================================
-- FISHES TABLES (existing — untouched)
-- ============================================================

CREATE TABLE IF NOT EXISTS players (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id   SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  note TEXT,
  attendance JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS session_results (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id)   ON DELETE CASCADE,
  amount     REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id       SERIAL PRIMARY KEY,
  payer_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  payee_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount   REAL    NOT NULL,
  date     TEXT    NOT NULL,
  status   TEXT    DEFAULT 'completed'
);

CREATE TABLE IF NOT EXISTS player_aliases (
  id        SERIAL  PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  alias     TEXT    UNIQUE NOT NULL
);

-- Back-fill status column for existing deployments
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS attendance JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS poker_now_trackers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      TEXT NOT NULL,
  game_url     TEXT NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'closed')),
  baseline     JSONB NOT NULL,
  cents_mode   BOOLEAN NOT NULL DEFAULT FALSE,
  access_token_hash TEXT,
  final_ledger JSONB,
  attendance   JSONB NOT NULL DEFAULT '[]'::jsonb,
  session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_poker_now_active_game
  ON poker_now_trackers(game_id) WHERE status = 'active';
ALTER TABLE poker_now_trackers
  ADD COLUMN IF NOT EXISTS cents_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS access_token_hash TEXT;

-- ============================================================
-- LIVE (THOR) TABLES — new, prefixed with live_
-- ============================================================

CREATE TABLE IF NOT EXISTS live_users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  username   TEXT        NOT NULL UNIQUE,
  password   TEXT        NOT NULL,
  mobile     TEXT,
  auth_token_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE live_users ADD COLUMN IF NOT EXISTS auth_token_hash TEXT;

CREATE TABLE IF NOT EXISTS live_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  session_code TEXT        NOT NULL UNIQUE,
  blind_value  TEXT        DEFAULT '10/20',
  created_by   UUID        REFERENCES live_users(id) ON DELETE SET NULL,
  status       TEXT        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'closed')),
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_session_players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES live_users(id)    ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'player'
                CHECK (role IN ('admin', 'player')),
  final_winnings NUMERIC
);

CREATE TABLE IF NOT EXISTS live_buy_ins (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID        REFERENCES live_sessions(id)       ON DELETE CASCADE,
  user_id    UUID        REFERENCES live_users(id)          ON DELETE CASCADE,
  amount     NUMERIC     NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'approved', 'rejected')),
  timestamp  TIMESTAMPTZ DEFAULT NOW()
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'live_buy_ins'::regclass
      AND conname = 'live_buy_ins_amount_valid'
  ) THEN
    ALTER TABLE live_buy_ins
      ADD CONSTRAINT live_buy_ins_amount_valid
      CHECK (
        amount > 0
        AND amount <= 1000000000
        AND amount <> 'NaN'::numeric
      ) NOT VALID;
  END IF;
END
$migration$;

-- Publish-to-Fishes flags on live_sessions (back-filled for existing rows via
-- ADD COLUMN IF NOT EXISTS so this is safe to re-run).
ALTER TABLE live_sessions
  ADD COLUMN IF NOT EXISTS published_to_ledger   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS published_session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS planned_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_reason TEXT;

-- Leave-table support: tracks when a player cashes out early while session is still active.
ALTER TABLE live_session_players
  ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leave_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pending_out_chips NUMERIC,
  ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commitment_type TEXT NOT NULL DEFAULT 'flexible',
  ADD COLUMN IF NOT EXISTS commitment_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commitment_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commitment_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commitment_adjusted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pending_plan_adjustment BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE live_session_players lsp
SET joined_at = ls.created_at
FROM live_sessions ls
WHERE lsp.session_id = ls.id AND lsp.joined_at IS NULL;

ALTER TABLE live_session_players ALTER COLUMN joined_at SET DEFAULT NOW();

CREATE TABLE IF NOT EXISTS live_attendance_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES live_users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('join', 'rejoin', 'leave', 'pause', 'resume')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'live_attendance_events'::regclass
      AND conname = 'live_attendance_events_event_type_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%pause%'
  ) THEN
    ALTER TABLE live_attendance_events
      DROP CONSTRAINT live_attendance_events_event_type_check;
    ALTER TABLE live_attendance_events
      ADD CONSTRAINT live_attendance_events_event_type_check
      CHECK (event_type IN ('join', 'rejoin', 'leave', 'pause', 'resume'));
  END IF;
END
$migration$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_live_sessions_code      ON live_sessions(session_code);
CREATE INDEX IF NOT EXISTS idx_live_buy_ins_session    ON live_buy_ins(session_id);
CREATE INDEX IF NOT EXISTS idx_live_sp_session         ON live_session_players(session_id);
CREATE INDEX IF NOT EXISTS idx_live_sp_user            ON live_session_players(user_id);
CREATE INDEX IF NOT EXISTS idx_live_attendance_session ON live_attendance_events(session_id, occurred_at);
