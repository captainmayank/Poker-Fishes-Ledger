import express from "express";
import { Pool } from "pg";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import {
  buildFishesPayload,
  PublishBuyInInput,
  PublishPlayerInput,
} from "./lib/publishToLedger.js";
import {
  buildCumulative,
  buildPlayerHistoryEvents,
  SessionResultRow,
  SettlementRow,
} from "./lib/playerHistory.js";
import {
  calculatePokerNowResults,
  parsePokerNowGameUrl,
  parsePokerNowLedger,
  type PokerNowLedgerPlayer,
} from "./lib/pokerNow.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "20mb" }));

// Treat loopback and common dev hosts as local (no SSL). Public hosts get SSL.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];
const isLocalDb = LOCAL_HOSTS.some((h) => process.env.DATABASE_URL?.includes(h));

// Extract host:port for boot-time logging without leaking credentials.
// Matches the host/port segment of a postgres URL, tolerates missing port.
function dbTargetForLog(url: string | undefined): string {
  if (!url) return "<unset>";
  const m = url.match(/@([^/?#]+)/);
  return m ? m[1] : "<unparseable>";
}

console.log(`[db] target: ${dbTargetForLog(process.env.DATABASE_URL)} (ssl: ${isLocalDb ? "off" : "on"})`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

// Surface pool-level errors (e.g. idle client disconnects) without crashing the
// process. Without this handler, emitted 'error' events on the Pool become
// uncaught exceptions.
pool.on("error", (err) => {
  console.error("[db] pool error:", err.message);
});

// ---------------------------------------------------------------------------
// Database initialisation — creates all tables on first run
// ---------------------------------------------------------------------------
const initDB = async () => {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('poker-fishes-ledger-schema-v1'))"
    );
    // ── Fishes tables (existing) ────────────────────────────────────────────
    await client.query(`
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
        id         SERIAL  PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
        player_id  INTEGER NOT NULL REFERENCES players(id)   ON DELETE CASCADE,
        amount     REAL    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settlements (
        id       SERIAL  PRIMARY KEY,
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
    `);

    // ── Live (Thor) tables (new) ────────────────────────────────────────────
    await client.query(`
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
                     CHECK (status IN ('active','closed')),
        closed_at    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS live_session_players (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id     UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id        UUID REFERENCES live_users(id)    ON DELETE CASCADE,
        role           TEXT NOT NULL DEFAULT 'player'
                       CHECK (role IN ('admin','player')),
        final_winnings NUMERIC
      );

      CREATE TABLE IF NOT EXISTS live_buy_ins (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID        REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id    UUID        REFERENCES live_users(id)    ON DELETE CASCADE,
        amount     NUMERIC     NOT NULL,
        status     TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected')),
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

      ALTER TABLE live_sessions
        ADD COLUMN IF NOT EXISTS published_to_ledger  BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS published_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS planned_end_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS end_reason TEXT;

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
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id  UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id     UUID NOT NULL REFERENCES live_users(id) ON DELETE CASCADE,
        event_type  TEXT NOT NULL CHECK (event_type IN ('join', 'rejoin', 'leave', 'pause', 'resume')),
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

      CREATE INDEX IF NOT EXISTS idx_live_sessions_code   ON live_sessions(session_code);
      CREATE INDEX IF NOT EXISTS idx_live_buy_ins_session ON live_buy_ins(session_id);
      CREATE INDEX IF NOT EXISTS idx_live_sp_session      ON live_session_players(session_id);
      CREATE INDEX IF NOT EXISTS idx_live_sp_user         ON live_session_players(user_id);
      CREATE INDEX IF NOT EXISTS idx_live_attendance_session
        ON live_attendance_events(session_id, occurred_at);
    `);
    await client.query("COMMIT");
    console.log("[db] initDB ok — schema verified");
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original initialization error is the actionable failure.
      }
    }
    console.error("[db] initDB failed — server will stay up, API calls will fail until DB is reachable:", err instanceof Error ? err.message : err);
    throw err;
  } finally {
    if (client) client.release();
  }
};

let initDBPromise: Promise<void> | null = null;

function ensureDatabaseInitialized() {
  if (!initDBPromise) {
    initDBPromise = initDB().catch((error) => {
      initDBPromise = null;
      throw error;
    });
  }
  return initDBPromise;
}

app.use(async (_req, res, next) => {
  try {
    await ensureDatabaseInitialized();
    next();
  } catch {
    res.status(503).json({ error: "Database initialization failed" });
  }
});

// ===========================================================================
// ── FISHES ROUTES (unchanged) ───────────────────────────────────────────────
// ===========================================================================

// Resolve player name via alias (case-insensitive)
async function resolvePlayerName(client: any, name: string): Promise<string> {
  const res = await client.query(
    `SELECT p.name FROM player_aliases pa
     JOIN players p ON pa.player_id = p.id
     WHERE LOWER(pa.alias) = LOWER($1)`,
    [name.trim()]
  );
  return res.rows.length > 0 ? res.rows[0].name : name.trim();
}

type UploadedAttendance = {
  externalId: string;
  name: string;
  joinedAt: string;
  leftAt: string;
  durationMinutes: number;
  handCount: number;
  confidence: "high" | "medium";
};

async function fetchPokerNowLedger(gameId: string): Promise<PokerNowLedgerPlayer[]> {
  const response = await fetch(
    `https://www.pokernow.com/games/${encodeURIComponent(gameId)}/players_sessions`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "PokerNow game was not found or is not accessible"
        : `PokerNow ledger request failed (${response.status})`
    );
  }
  return parsePokerNowLedger(await response.json());
}

async function fetchPokerNowCentsMode(gameId: string): Promise<boolean> {
  const response = await fetch(
    `https://www.pokernow.com/games/${encodeURIComponent(gameId)}/current_or_next_configs`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    }
  );
  if (!response.ok) {
    throw new Error(`PokerNow configuration request failed (${response.status})`);
  }
  const config = (await response.json()) as { cM?: unknown };
  return config.cM === true;
}

function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readBearerToken(req: any): string | null {
  const authorization =
    typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function accessTokenMatches(token: string | null, expectedHash: unknown): boolean {
  if (!token || typeof expectedHash !== "string") return false;
  const actual = Buffer.from(hashAccessToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function mapPokerNowTracker(row: any) {
  return {
    id: row.id,
    gameId: row.game_id,
    gameUrl: row.game_url,
    note: row.note ?? "",
    status: row.status,
    startedAt: new Date(row.started_at).getTime(),
    endedAt: row.ended_at ? new Date(row.ended_at).getTime() : undefined,
    sessionId: row.session_id == null ? null : Number(row.session_id),
  };
}

function normalizeUploadedAttendance(value: unknown): UploadedAttendance[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("attendance must be an array with at most 100 players");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`attendance[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const externalId = typeof item.externalId === "string" ? item.externalId.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const joinedAt = typeof item.joinedAt === "string" ? item.joinedAt : "";
    const leftAt = typeof item.leftAt === "string" ? item.leftAt : "";
    const durationMinutes = Number(item.durationMinutes);
    const handCount = Number(item.handCount);
    const confidence = item.confidence;

    if (!externalId || externalId.length > 100 || !name || name.length > 100) {
      throw new Error(`attendance[${index}] has an invalid player identity`);
    }
    if (
      !Number.isFinite(Date.parse(joinedAt)) ||
      !Number.isFinite(Date.parse(leftAt)) ||
      Date.parse(leftAt) < Date.parse(joinedAt)
    ) {
      throw new Error(`attendance[${index}] has invalid timestamps`);
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0 || durationMinutes > 1440) {
      throw new Error(`attendance[${index}] has an invalid duration`);
    }
    if (!Number.isInteger(handCount) || handCount < 1 || handCount > 100000) {
      throw new Error(`attendance[${index}] has an invalid hand count`);
    }
    if (confidence !== "high" && confidence !== "medium") {
      throw new Error(`attendance[${index}] has an invalid confidence`);
    }

    return {
      externalId,
      name,
      joinedAt,
      leftAt,
      durationMinutes,
      handCount,
      confidence,
    };
  });
}

const PLAYERS_QUERY = `
  SELECT
    p.id,
    p.name,
    (
      COALESCE((SELECT SUM(amount) FROM session_results WHERE player_id = p.id), 0)
      + COALESCE((SELECT SUM(amount) FROM settlements WHERE payer_id = p.id AND status = 'completed'), 0)
      - COALESCE((SELECT SUM(amount) FROM settlements WHERE payee_id = p.id AND status = 'completed'), 0)
    ) AS total_profit
  FROM players p
  ORDER BY total_profit DESC
`;

const SESSIONS_QUERY = `
  SELECT s.id, s.date, s.note, s.attendance,
         COALESCE(
           json_agg(
             json_build_object('name', p.name, 'amount', sr.amount)
           ) FILTER (WHERE sr.id IS NOT NULL),
           '[]'
         ) AS results
  FROM sessions s
  LEFT JOIN session_results sr ON sr.session_id = s.id
  LEFT JOIN players p ON sr.player_id = p.id
  GROUP BY s.id
  ORDER BY s.date DESC
`;

const SETTLEMENTS_QUERY = `
  SELECT s.id, s.amount, s.date, s.status,
         p1.name AS payer, p2.name AS payee
  FROM settlements s
  JOIN players p1 ON s.payer_id = p1.id
  JOIN players p2 ON s.payee_id = p2.id
  ORDER BY s.date DESC, s.id DESC
`;

const PLAYER_ALIASES_QUERY = `
  SELECT p.id, p.name,
    COALESCE(
      json_agg(json_build_object('id', pa.id, 'alias', pa.alias))
      FILTER (WHERE pa.id IS NOT NULL), '[]'
    ) AS aliases,
    COALESCE((SELECT SUM(sr.amount) FROM session_results sr WHERE sr.player_id = p.id), 0) AS session_profit
  FROM players p
  LEFT JOIN player_aliases pa ON pa.player_id = p.id
  GROUP BY p.id
  ORDER BY p.name
`;

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const [players, sessions, settlements, playersWithAliases] = await Promise.all([
      pool.query(PLAYERS_QUERY),
      pool.query(SESSIONS_QUERY),
      pool.query(SETTLEMENTS_QUERY),
      pool.query(PLAYER_ALIASES_QUERY),
    ]);
    res.json({
      players: players.rows,
      sessions: sessions.rows,
      settlements: settlements.rows,
      playersWithAliases: playersWithAliases.rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load application data" });
  }
});

async function getPokerNowFinalizedSession(db: any, tracker: any) {
  if (tracker.session_id == null) return null;
  const result = await db.query(
    `SELECT s.id, s.date, s.note, s.attendance,
            COALESCE(
              json_agg(json_build_object('name', p.name, 'amount', sr.amount))
                FILTER (WHERE sr.id IS NOT NULL),
              '[]'
            ) AS results
     FROM sessions s
     LEFT JOIN session_results sr ON sr.session_id = s.id
     LEFT JOIN players p ON p.id = sr.player_id
     WHERE s.id = $1
     GROUP BY s.id`,
    [tracker.session_id]
  );
  return result.rows[0] ?? null;
}

app.post("/api/pokernow/start", async (req, res) => {
  let parsed: { gameId: string; gameUrl: string };
  try {
    parsed = parsePokerNowGameUrl(req.body.url);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid PokerNow link",
    });
  }
  const note = typeof req.body.note === "string" ? req.body.note.trim().slice(0, 200) : "";
  const accessToken =
    typeof req.body.accessToken === "string" ? req.body.accessToken.trim() : "";
  if (accessToken.length < 32 || accessToken.length > 200) {
    return res.status(400).json({ error: "A valid tracker access token is required" });
  }
  const accessTokenHash = hashAccessToken(accessToken);

  try {
    const existing = await pool.query(
      `SELECT id, game_id, game_url, note, status, started_at, ended_at, session_id,
              access_token_hash
       FROM poker_now_trackers
       WHERE game_id = $1 AND status = 'active'`,
      [parsed.gameId]
    );
    if (existing.rows.length > 0) {
      if (!accessTokenMatches(accessToken, existing.rows[0].access_token_hash)) {
        return res.status(409).json({
          error: "This PokerNow game is already being tracked on another device",
        });
      }
      return res.json({ tracker: mapPokerNowTracker(existing.rows[0]), alreadyStarted: true });
    }

    const [baseline, centsMode] = await Promise.all([
      fetchPokerNowLedger(parsed.gameId),
      fetchPokerNowCentsMode(parsed.gameId),
    ]);
    const result = await pool.query(
      `INSERT INTO poker_now_trackers
         (game_id, game_url, note, baseline, cents_mode, access_token_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (game_id) WHERE status = 'active' DO NOTHING
       RETURNING id, game_id, game_url, note, status, started_at, ended_at, session_id`,
      [
        parsed.gameId,
        parsed.gameUrl,
        note,
        JSON.stringify(baseline),
        centsMode,
        accessTokenHash,
      ]
    );
    if (result.rows.length === 0) {
      const raced = await pool.query(
        `SELECT id, game_id, game_url, note, status, started_at, ended_at, session_id,
                access_token_hash
         FROM poker_now_trackers
         WHERE game_id = $1 AND status = 'active'`,
        [parsed.gameId]
      );
      if (
        raced.rows.length === 0 ||
        !accessTokenMatches(accessToken, raced.rows[0].access_token_hash)
      ) {
        return res.status(409).json({
          error: "This PokerNow game is already being tracked on another device",
        });
      }
      return res.json({ tracker: mapPokerNowTracker(raced.rows[0]), alreadyStarted: true });
    }
    res.status(201).json({ tracker: mapPokerNowTracker(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Could not start PokerNow tracking",
    });
  }
});

app.post("/api/pokernow/:id/finalize", async (req, res) => {
  const { id } = req.params;
  if (!UUID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Invalid PokerNow tracker id" });
  }
  let attendance: UploadedAttendance[];
  try {
    attendance = normalizeUploadedAttendance(req.body.attendance);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid attendance",
    });
  }
  if (attendance.length === 0) {
    return res.status(400).json({ error: "Upload a PokerNow Game Log before finalizing" });
  }

  const trackerRes = await pool.query(
    "SELECT * FROM poker_now_trackers WHERE id = $1",
    [id]
  );
  if (trackerRes.rows.length === 0) {
    return res.status(404).json({ error: "PokerNow tracker not found" });
  }
  const tracker = trackerRes.rows[0];
  if (!accessTokenMatches(readBearerToken(req), tracker.access_token_hash)) {
    return res.status(401).json({ error: "Invalid PokerNow tracker access token" });
  }
  if (tracker.status === "closed") {
    const session = await getPokerNowFinalizedSession(pool, tracker);
    return session
      ? res.json({ tracker: mapPokerNowTracker(tracker), session })
      : res.status(409).json({ error: "This PokerNow session is already finalized" });
  }

  let finalLedger: PokerNowLedgerPlayer[];
  try {
    finalLedger = await fetchPokerNowLedger(tracker.game_id);
  } catch (error) {
    console.error(error);
    return res.status(502).json({
      error:
        error instanceof Error
          ? `${error.message}. Upload a ledger file as a fallback.`
          : "Could not fetch the PokerNow ledger",
    });
  }

  const baseline: PokerNowLedgerPlayer[] = Array.isArray(tracker.baseline)
    ? tracker.baseline
    : [];
  const startedAt = new Date(tracker.started_at).getTime();
  const endedAt = Date.now();
  if (
    attendance.some(
      (entry) =>
        Date.parse(entry.joinedAt) < startedAt - 1000 ||
        Date.parse(entry.leftAt) > endedAt + 60_000
    )
  ) {
    return res.status(400).json({
      error: "The Game Log includes hands outside this tracked session. Re-import it from the active tracker.",
    });
  }

  const results = calculatePokerNowResults(
    baseline,
    finalLedger,
    attendance,
    tracker.cents_mode === true
  );
  if (results.length === 0) {
    return res.status(422).json({ error: "No PokerNow players were found" });
  }

  const date = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const note = tracker.note || `PokerNow ${tracker.game_id}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT * FROM poker_now_trackers WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (locked.rows[0].status !== "active") {
      const session = await getPokerNowFinalizedSession(client, locked.rows[0]);
      await client.query("COMMIT");
      return session
        ? res.json({ tracker: mapPokerNowTracker(locked.rows[0]), session })
        : res.status(409).json({ error: "This PokerNow session is already finalized" });
    }
    const sessionRes = await client.query(
      `INSERT INTO sessions (date, note, attendance)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [date, note, JSON.stringify(attendance)]
    );
    const sessionId = Number(sessionRes.rows[0].id);
    await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(name TEXT, amount NUMERIC)
       ), resolved AS (
         SELECT
           COALESCE((
             SELECT p.name
             FROM player_aliases pa
             JOIN players p ON p.id = pa.player_id
             WHERE LOWER(pa.alias) = LOWER(TRIM(input.name))
             LIMIT 1
           ), TRIM(input.name)) AS name,
           amount
         FROM input
       ), totals AS (
         SELECT name, SUM(amount) AS amount
         FROM resolved
         GROUP BY name
       ), upserted AS (
         INSERT INTO players (name)
         SELECT name FROM totals
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name
       )
       INSERT INTO session_results (session_id, player_id, amount)
       SELECT $2, upserted.id, totals.amount
       FROM totals
       JOIN upserted USING (name)`,
      [JSON.stringify(results), sessionId]
    );
    await client.query(
      `UPDATE poker_now_trackers
       SET status = 'closed', ended_at = NOW(), final_ledger = $1::jsonb,
           attendance = $2::jsonb, session_id = $3
       WHERE id = $4`,
      [JSON.stringify(finalLedger), JSON.stringify(attendance), sessionId, id]
    );
    await client.query("COMMIT");
    res.json({
      tracker: {
        ...mapPokerNowTracker({
          ...tracker,
          status: "closed",
          ended_at: new Date(),
          session_id: sessionId,
        }),
      },
      session: {
        id: sessionId,
        date,
        note,
        attendance,
        results: results.map(({ name, amount }) => ({ name, amount })),
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to finalize PokerNow session" });
  } finally {
    client.release();
  }
});

app.get("/api/players", async (req, res) => {
  try {
    const { rows } = await pool.query(PLAYERS_QUERY);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

// Per-player event history for the Leaderboard popup. Raw session_results
// and settlements rows are fetched here; sign flipping, "Settled with" /
// "Received from" phrasing, sort order, and the running total all live in
// api/lib/playerHistory.ts so a single unit-tested helper enforces the
// invariant `cumulative[last].total === /api/players.total_profit`.
app.get("/api/players/:id/history", async (req, res) => {
  const playerId = parseInt(req.params.id, 10);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    return res.status(400).json({ error: "Invalid player id" });
  }
  try {
    const playerRes = await pool.query(
      "SELECT id, name FROM players WHERE id = $1",
      [playerId]
    );
    if (playerRes.rows.length === 0) {
      return res.status(404).json({ error: "Player not found" });
    }
    const sessionRes = await pool.query(
      `SELECT s.date, sr.amount::numeric AS amount, COALESCE(s.note, '') AS note
         FROM session_results sr
         JOIN sessions s ON sr.session_id = s.id
        WHERE sr.player_id = $1`,
      [playerId]
    );
    const settleRes = await pool.query(
      `SELECT st.date, st.amount::numeric AS amount, st.status,
              'payer' AS role, payee.name AS counterparty_name
         FROM settlements st
         JOIN players payee ON st.payee_id = payee.id
        WHERE st.payer_id = $1
       UNION ALL
       SELECT st.date, st.amount::numeric AS amount, st.status,
              'payee' AS role, payer.name AS counterparty_name
         FROM settlements st
         JOIN players payer ON st.payer_id = payer.id
        WHERE st.payee_id = $1`,
      [playerId]
    );

    const sessions: SessionResultRow[] = sessionRes.rows.map((r: any) => ({
      date: r.date,
      amount: parseFloat(r.amount),
      note: r.note,
    }));
    const settlements: SettlementRow[] = settleRes.rows.map((r: any) => ({
      date: r.date,
      amount: parseFloat(r.amount),
      status: r.status,
      role: r.role,
      counterpartyName: r.counterparty_name,
    }));

    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cumulative = buildCumulative(events);

    res.json({
      player: playerRes.rows[0],
      events,
      cumulative,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch player history" });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(SESSIONS_QUERY);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { date, note, results } = req.body;
  let attendance: UploadedAttendance[];
  try {
    attendance = normalizeUploadedAttendance(req.body.attendance);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid attendance",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRes = await client.query(
      "INSERT INTO sessions (date, note, attendance) VALUES ($1, $2, $3::jsonb) RETURNING id",
      [date, note, JSON.stringify(attendance)]
    );
    const sessionId = sessionRes.rows[0].id;
    for (const result of results) {
      const resolvedName = await resolvePlayerName(client, result.name);
      const playerRes = await client.query(
        "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [resolvedName]
      );
      await client.query(
        "INSERT INTO session_results (session_id, player_id, amount) VALUES ($1, $2, $3)",
        [sessionId, playerRes.rows[0].id, result.amount]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, sessionId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to save session" });
  } finally {
    client.release();
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM session_results WHERE session_id = $1", [req.params.id]);
    await client.query("DELETE FROM sessions WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to delete session" });
  } finally {
    client.release();
  }
});

app.get("/api/settlements", async (req, res) => {
  try {
    const { rows } = await pool.query(SETTLEMENTS_QUERY);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch settlements" });
  }
});

app.post("/api/settlements", async (req, res) => {
  const { payer, payee, amount, date } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payerRes = await client.query(
      "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [payer]
    );
    const payeeRes = await client.query(
      "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [payee]
    );
    const settlementRes = await client.query(
      "INSERT INTO settlements (payer_id, payee_id, amount, date, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id",
      [payerRes.rows[0].id, payeeRes.rows[0].id, amount, date]
    );
    await client.query("COMMIT");
    res.json({ success: true, settlementId: settlementRes.rows[0].id });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to save settlement" });
  } finally {
    client.release();
  }
});

app.delete("/api/settlements/:id", async (req, res) => {
  try {
    await pool.query("UPDATE settlements SET status = 'voided' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to void settlement" });
  }
});

app.patch("/api/settlements/:id/restore", async (req, res) => {
  try {
    await pool.query("UPDATE settlements SET status = 'completed' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to restore settlement" });
  }
});

// Player alias management
app.get("/api/players/aliases", async (req, res) => {
  try {
    const { rows } = await pool.query(PLAYER_ALIASES_QUERY);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch player aliases" });
  }
});

app.post("/api/players/:id/aliases", async (req, res) => {
  const { alias } = req.body;
  if (!alias?.trim()) return res.status(400).json({ error: "Alias cannot be empty" });
  try {
    const existing = await pool.query(
      "SELECT id FROM players WHERE LOWER(name) = LOWER($1)",
      [alias.trim()]
    );
    if (existing.rows.length > 0 && existing.rows[0].id !== parseInt(req.params.id)) {
      return res.status(409).json({
        error: `"${alias}" is already a player name. Merge them instead.`,
      });
    }
    await pool.query(
      "INSERT INTO player_aliases (player_id, alias) VALUES ($1, $2)",
      [req.params.id, alias.trim()]
    );
    res.json({ success: true });
  } catch (error: any) {
    if (error?.code === "23505")
      return res.status(409).json({ error: "This alias is already mapped to a player." });
    console.error(error);
    res.status(500).json({ error: "Failed to add alias" });
  }
});

app.delete("/api/players/aliases/:aliasId", async (req, res) => {
  try {
    await pool.query("DELETE FROM player_aliases WHERE id = $1", [req.params.aliasId]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to remove alias" });
  }
});

app.post("/api/players/merge", async (req, res) => {
  const { sourceId, targetId } = req.body;
  if (!sourceId || !targetId || sourceId === targetId)
    return res.status(400).json({ error: "Invalid merge parameters" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const srcRes = await client.query("SELECT name FROM players WHERE id = $1", [sourceId]);
    if (srcRes.rows.length > 0) {
      await client.query(
        "INSERT INTO player_aliases (player_id, alias) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING",
        [targetId, srcRes.rows[0].name]
      );
    }
    await client.query("UPDATE player_aliases SET player_id = $1 WHERE player_id = $2", [targetId, sourceId]);
    await client.query("UPDATE session_results SET player_id = $1 WHERE player_id = $2", [targetId, sourceId]);
    await client.query("UPDATE settlements SET payer_id = $1 WHERE payer_id = $2", [targetId, sourceId]);
    await client.query("UPDATE settlements SET payee_id = $1 WHERE payee_id = $2", [targetId, sourceId]);
    await client.query("DELETE FROM players WHERE id = $1", [sourceId]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to merge players" });
  } finally {
    client.release();
  }
});

app.delete("/api/players/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM player_aliases WHERE player_id = $1", [req.params.id]);
    await client.query("DELETE FROM session_results WHERE player_id = $1", [req.params.id]);
    await client.query("DELETE FROM settlements WHERE payer_id = $1 OR payee_id = $1", [req.params.id]);
    await client.query("DELETE FROM players WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to delete player" });
  } finally {
    client.release();
  }
});

app.post("/api/reset", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM session_results");
    await client.query("DELETE FROM settlements");
    await client.query("DELETE FROM player_aliases");
    await client.query("DELETE FROM sessions");
    await client.query("DELETE FROM players");
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to reset data" });
  } finally {
    client.release();
  }
});

// AI extraction (Gemini)
app.post("/api/extract", async (req, res) => {
  const { data, mimeType, isText } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Gemini API key is not configured on the server." });

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `Extract player names and their profit/loss amounts from this poker session data.
Return a JSON array of objects with 'name' (string) and 'amount' (number, positive = profit, negative = loss).`;
  const parts: any[] = [{ text: prompt }];
  if (isText) {
    parts.push({ text: data });
  } else {
    const base64Data = data.includes(",") ? data.split(",")[1] : data;
    parts.push({ inlineData: { mimeType, data: base64Data } });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name:   { type: Type.STRING },
              amount: { type: Type.NUMBER },
            },
            required: ["name", "amount"],
          },
        },
      },
    });
    res.json(JSON.parse(response.text || "[]"));
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    const msg = error?.message || "";
    if (msg.includes("API key"))
      return res.status(401).json({ error: "Invalid or missing Gemini API key." });
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota"))
      return res.status(429).json({ error: "Gemini API rate limit exceeded. Please wait and try again." });
    res.status(500).json({ error: "Failed to process file with AI. Please try again." });
  }
});

// ===========================================================================
// ── LIVE (THOR) ROUTES — all under /api/live/ ───────────────────────────────
// ===========================================================================

// Helper: generate random 6-char alphanumeric session code
function generateCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMITMENT_TYPES = new Set(["full", "custom", "flexible"]);

type CommitmentType = "full" | "custom" | "flexible";

function buildCommitment(
  rawType: unknown,
  plannedEndAt: string | Date | null,
  rawMinutes: unknown,
  now = new Date()
): {
  type: CommitmentType;
  startAt: Date | null;
  endAt: Date | null;
  lockedAt: Date;
} {
  const type = typeof rawType === "string" ? rawType : "flexible";
  if (!COMMITMENT_TYPES.has(type)) {
    throw new Error("commitmentType must be full, custom or flexible");
  }
  if (type === "flexible") {
    return { type: "flexible", startAt: null, endAt: null, lockedAt: now };
  }

  if (type === "full") {
    const endAt = plannedEndAt ? new Date(plannedEndAt) : null;
    if (!endAt || !Number.isFinite(endAt.getTime()) || endAt <= now) {
      throw new Error("The table's planned end has passed; choose a custom or flexible plan");
    }
    return { type: "full", startAt: now, endAt, lockedAt: now };
  }

  const minutes = Number(rawMinutes);
  if (!Number.isInteger(minutes) || minutes < 60 || minutes > 720) {
    throw new Error("Custom plans must be between 60 and 720 minutes");
  }
  return {
    type: "custom",
    startAt: now,
    endAt: new Date(now.getTime() + minutes * 60_000),
    lockedAt: now,
  };
}

async function getLiveSessionSnapshot(db: any, idOrCode: string) {
  const sessRes = await db.query(
    UUID_PATTERN.test(idOrCode)
      ? "SELECT * FROM live_sessions WHERE id = $1"
      : "SELECT * FROM live_sessions WHERE UPPER(session_code) = UPPER($1)",
    [idOrCode]
  );
  if (sessRes.rows.length === 0) return null;
  const session = sessRes.rows[0];

  const [playersRes, buyInsRes, attendanceRes] = await Promise.all([
    db.query(
      `SELECT lsp.*, lu.name
       FROM live_session_players lsp
       JOIN live_users lu ON lsp.user_id = lu.id
       WHERE lsp.session_id = $1
       ORDER BY lsp.joined_at ASC, lsp.id ASC`,
      [session.id]
    ),
    db.query(
      `SELECT * FROM live_buy_ins
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [session.id]
    ),
    db.query(
      `SELECT id, session_id, user_id, event_type, occurred_at
       FROM live_attendance_events
       WHERE session_id = $1
       ORDER BY occurred_at ASC, id ASC`,
      [session.id]
    ),
  ]);

  return {
    session,
    players: playersRes.rows,
    buyIns: buyInsRes.rows,
    attendanceEvents: attendanceRes.rows,
  };
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function issueLiveAuthToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    "UPDATE live_users SET auth_token_hash = $1 WHERE id = $2",
    [hashAccessToken(token), userId]
  );
  return token;
}

async function authenticateLiveRequest(req: any) {
  const token = readBearerToken(req);
  if (!token) return null;
  const result = await pool.query(
    "SELECT id, auth_token_hash FROM live_users WHERE auth_token_hash = $1",
    [hashAccessToken(token)]
  );
  if (
    result.rows.length === 0 ||
    !accessTokenMatches(token, result.rows[0].auth_token_hash)
  ) {
    return null;
  }
  return result.rows[0] as { id: string };
}

app.post("/api/live/auth/register", async (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password)
    return res.status(400).json({ error: "name, username and password are required" });
  try {
    const dup = await pool.query(
      "SELECT id FROM live_users WHERE LOWER(username) = LOWER($1)",
      [username]
    );
    if (dup.rows.length > 0)
      return res.status(409).json({ error: "Username already taken" });
    const authToken = randomBytes(32).toString("base64url");
    const result = await pool.query(
      `INSERT INTO live_users (name, username, password, auth_token_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, username, mobile`,
      [name.trim(), username.trim(), password, hashAccessToken(authToken)]
    );
    res.status(201).json({ user: { ...result.rows[0], authToken } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/live/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "username and password are required" });
  try {
    const result = await pool.query(
      "SELECT id, name, username, mobile FROM live_users WHERE LOWER(username) = LOWER($1) AND password = $2",
      [username, password]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Invalid username or password" });
    const authToken = await issueLiveAuthToken(result.rows[0].id);
    res.json({ user: { ...result.rows[0], authToken } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Sessions ────────────────────────────────────────────────────────────────

async function getLiveSessionsForUser(userId?: string) {
  if (userId) {
    const result = await pool.query(
      `SELECT DISTINCT ls.*
       FROM live_sessions ls
       LEFT JOIN live_session_players lsp ON ls.id = lsp.session_id
       WHERE lsp.user_id = $1 OR ls.created_by = $1 OR ls.status = 'active'
       ORDER BY ls.created_at DESC`,
      [userId]
    );
    return result.rows;
  }
  const result = await pool.query(
    "SELECT * FROM live_sessions ORDER BY created_at DESC"
  );
  return result.rows;
}

async function getLiveUserStats(userId: string) {
  const statsRes = await pool.query(
    `SELECT
      COALESCE(SUM(CASE WHEN ls.created_at >= NOW() - INTERVAL '7 days'
        THEN (COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)) ELSE 0 END), 0) AS "weeklyPL",
      COALESCE(SUM(CASE WHEN ls.created_at >= NOW() - INTERVAL '30 days'
        THEN (COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)) ELSE 0 END), 0) AS "monthlyPL",
      COALESCE(SUM(CASE WHEN ls.created_at >= NOW() - INTERVAL '365 days'
        THEN (COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)) ELSE 0 END), 0) AS "yearlyPL",
      COALESCE(SUM(COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)), 0) AS "totalPL"
     FROM live_session_players lsp
     JOIN live_sessions ls ON lsp.session_id = ls.id
     LEFT JOIN (
       SELECT session_id, user_id, SUM(amount) AS total_buyin
       FROM live_buy_ins WHERE status = 'approved'
       GROUP BY session_id, user_id
     ) bi ON bi.session_id = lsp.session_id AND bi.user_id = lsp.user_id
     WHERE lsp.user_id = $1 AND ls.status = 'closed'`,
    [userId]
  );
  const stats = statsRes.rows[0] || {
    weeklyPL: 0, monthlyPL: 0, yearlyPL: 0, totalPL: 0,
  };

  const historyRes = await pool.query(
    `SELECT
       ls.id           AS session_id,
       ls.name         AS session_name,
       ls.created_at   AS session_date,
       COALESCE(lsp.final_winnings, 0)     AS final_winnings,
       COALESCE(bi.total_buyin, 0)         AS buyin_amount
     FROM live_session_players lsp
     JOIN live_sessions ls ON lsp.session_id = ls.id
     LEFT JOIN (
       SELECT session_id, user_id, SUM(amount) AS total_buyin
       FROM live_buy_ins WHERE status = 'approved'
       GROUP BY session_id, user_id
     ) bi ON bi.session_id = lsp.session_id AND bi.user_id = lsp.user_id
     WHERE lsp.user_id = $1 AND ls.status = 'closed'
     ORDER BY ls.created_at ASC`,
    [userId]
  );
  const history = historyRes.rows.map((row: any) => ({
    sessionId: row.session_id,
    sessionName: row.session_name,
    date: new Date(row.session_date).getTime(),
    pl: parseFloat(row.final_winnings) - parseFloat(row.buyin_amount),
  }));
  return { ...stats, history };
}

app.get("/api/live/sessions", async (req, res) => {
  const { userId } = req.query as { userId?: string };
  try {
    res.json(await getLiveSessionsForUser(userId));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch live sessions" });
  }
});

app.get("/api/live/lobby/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!UUID_PATTERN.test(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  try {
    const [sessions, stats] = await Promise.all([
      getLiveSessionsForUser(userId),
      getLiveUserStats(userId),
    ]);
    res.json({ sessions, stats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load live lobby" });
  }
});

app.post("/api/live/sessions", async (req, res) => {
  const {
    name,
    blindValue,
    createdBy,
    plannedDurationMinutes,
    hostCommitmentType,
    hostCommitmentMinutes,
  } = req.body;
  if (!name || !createdBy)
    return res.status(400).json({ error: "name and createdBy are required" });
  const durationMinutes = Number(plannedDurationMinutes ?? 240);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 60 || durationMinutes > 720) {
    return res.status(400).json({ error: "plannedDurationMinutes must be between 60 and 720" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const code = generateCode();
    const createdAt = new Date();
    const plannedEndAt = new Date(createdAt.getTime() + durationMinutes * 60_000);
    const hostPlan = buildCommitment(
      hostCommitmentType ?? "full",
      plannedEndAt,
      hostCommitmentMinutes,
      createdAt
    );
    const sessionRes = await client.query(
      `INSERT INTO live_sessions
         (name, session_code, blind_value, created_by, planned_end_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), code, blindValue || "10/20", createdBy, plannedEndAt, createdAt]
    );
    const session = sessionRes.rows[0];
    await client.query(
      `INSERT INTO live_session_players
         (session_id, user_id, role, joined_at, commitment_type,
          commitment_start_at, commitment_end_at, commitment_locked_at)
       VALUES ($1, $2, 'admin', $3, $4, $5, $6, $7)`,
      [
        session.id,
        createdBy,
        createdAt,
        hostPlan.type,
        hostPlan.startAt,
        hostPlan.endAt,
        hostPlan.lockedAt,
      ]
    );
    await client.query(
      `INSERT INTO live_attendance_events
         (session_id, user_id, event_type, occurred_at)
       VALUES ($1, $2, 'join', $3)`,
      [session.id, createdBy, createdAt]
    );
    const snapshot = await getLiveSessionSnapshot(client, session.id);
    await client.query("COMMIT");
    res.status(201).json(snapshot);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to create live session";
    res.status(message.includes("commitment") || message.includes("plan") ? 400 : 500).json({
      error: message,
    });
  } finally {
    client.release();
  }
});

// Publish a closed live session to the Fishes ledger. One-shot: inserts
// one Fishes `sessions` row plus one `session_results` row per player, then
// flips `published_to_ledger`/`published_session_id` on the live session so
// the button can't fire twice. All writes run inside a single transaction
// so a failure mid-way rolls the Fishes insert back and leaves the live
// session's published flag untouched.
app.post("/api/live/sessions/:id/publish", async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid session id" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sessRes = await client.query(
      `SELECT id, name, status, closed_at, published_to_ledger, published_session_id
       FROM live_sessions WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (sessRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }
    const s = sessRes.rows[0];

    const playersRes = await client.query(
      `SELECT lsp.user_id, lu.name, lsp.final_winnings
       FROM live_session_players lsp
       JOIN live_users lu ON lsp.user_id = lu.id
       WHERE lsp.session_id = $1`,
      [id]
    );
    const players: PublishPlayerInput[] = playersRes.rows.map((r: any) => ({
      userId: r.user_id,
      name: r.name,
      finalWinnings: r.final_winnings == null ? null : parseFloat(r.final_winnings),
    }));

    const buyInsRes = await client.query(
      `SELECT user_id, amount, status FROM live_buy_ins WHERE session_id = $1`,
      [id]
    );
    const buyIns: PublishBuyInInput[] = buyInsRes.rows.map((r: any) => ({
      userId: r.user_id,
      amount: parseFloat(r.amount),
      status: r.status,
    }));

    const validation = buildFishesPayload(
      {
        id: s.id,
        name: s.name,
        status: s.status,
        closedAt: s.closed_at,
        publishedToLedger: s.published_to_ledger,
        publishedSessionId: s.published_session_id,
      },
      players,
      buyIns
    );

    if (validation.ok === false) {
      await client.query("ROLLBACK");
      const err = validation.error;
      if (err.code === "already_published") {
        return res
          .status(409)
          .json({ alreadyPublished: true, fishesSessionId: err.fishesSessionId });
      }
      return res.status(422).json({ error: err.message });
    }

    const { date, note, results } = validation.payload;
    const insertSession = await client.query(
      "INSERT INTO sessions (date, note) VALUES ($1, $2) RETURNING id",
      [date, note]
    );
    const fishesSessionId: number = insertSession.rows[0].id;

    for (const r of results) {
      const resolvedName = await resolvePlayerName(client, r.name);
      const playerRes = await client.query(
        "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [resolvedName]
      );
      await client.query(
        "INSERT INTO session_results (session_id, player_id, amount) VALUES ($1, $2, $3)",
        [fishesSessionId, playerRes.rows[0].id, r.amount]
      );
    }

    await client.query(
      `UPDATE live_sessions
       SET published_to_ledger = TRUE, published_session_id = $1
       WHERE id = $2`,
      [fishesSessionId, id]
    );

    await client.query("COMMIT");
    res.json({ fishesSessionId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to publish session" });
  } finally {
    client.release();
  }
});

// Specific session sub-routes MUST come before the /:idOrCode param route
app.post("/api/live/session/join", async (req, res) => {
  const { code, userId, role, commitmentType, commitmentMinutes } = req.body;
  if (!code || !userId)
    return res.status(400).json({ error: "code and userId are required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessRes = await client.query(
      "SELECT * FROM live_sessions WHERE UPPER(session_code) = UPPER($1) FOR UPDATE",
      [code]
    );
    if (sessRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session code not found" });
    }
    const session = sessRes.rows[0];
    if (session.status === "closed") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Session is closed" });
    }

    const existing = await client.query(
      "SELECT * FROM live_session_players WHERE session_id = $1 AND user_id = $2",
      [session.id, userId]
    );
    if (existing.rows.length > 0) {
      const player = existing.rows[0];
      if (player.left_at !== null) {
        const rejoinedAt = new Date();
        await client.query(
          `UPDATE live_session_players
           SET left_at = NULL, final_winnings = NULL,
               leave_pending = FALSE, pending_out_chips = NULL
           WHERE session_id = $1 AND user_id = $2
           RETURNING *`,
          [session.id, userId]
        );
        await client.query(
          `INSERT INTO live_attendance_events
             (session_id, user_id, event_type, occurred_at)
           VALUES ($1, $2, 'rejoin', $3)`,
          [session.id, userId, rejoinedAt]
        );
      }
      const snapshot = await getLiveSessionSnapshot(client, session.id);
      await client.query("COMMIT");
      return res.status(200).json(snapshot);
    }

    const playerRole = role || "player";
    const joinedAt = new Date();
    const commitment = buildCommitment(
      commitmentType,
      session.planned_end_at,
      commitmentMinutes,
      joinedAt
    );
    await client.query(
      `INSERT INTO live_session_players
         (session_id, user_id, role, joined_at, commitment_type,
          commitment_start_at, commitment_end_at, commitment_locked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        session.id,
        userId,
        playerRole,
        joinedAt,
        commitment.type,
        commitment.startAt,
        commitment.endAt,
        commitment.lockedAt,
      ]
    );
    await client.query(
      `INSERT INTO live_attendance_events
         (session_id, user_id, event_type, occurred_at)
       VALUES ($1, $2, 'join', $3)`,
      [session.id, userId, joinedAt]
    );
    const snapshot = await getLiveSessionSnapshot(client, session.id);
    await client.query("COMMIT");
    res.status(201).json(snapshot);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to join session";
    res.status(
      message.includes("commitment") ||
        message.includes("plans") ||
        message.includes("table's planned end")
        ? 400
        : 500
    ).json({ error: message });
  } finally {
    client.release();
  }
});

app.post("/api/live/session/buyin", async (req, res) => {
  const { sessionId, userId, amount, status } = req.body;
  if (!sessionId || !userId || amount === undefined)
    return res.status(400).json({ error: "sessionId, userId and amount are required" });
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1_000_000_000
  ) {
    return res.status(400).json({ error: "amount must be a finite positive number" });
  }
  const buyInStatus = status || "pending";
  if (buyInStatus !== "pending" && buyInStatus !== "approved") {
    return res.status(400).json({ error: "Invalid initial buy-in status" });
  }
  let actor: { id: string } | null;
  try {
    actor = await authenticateLiveRequest(req);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not authenticate buy-in" });
  }
  if (!actor) return res.status(401).json({ error: "Sign in again to add a buy-in" });
  if (actor.id !== userId) {
    return res.status(403).json({ error: "Buy-ins can only be requested for yourself" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRes = await client.query(
      "SELECT status, created_by FROM live_sessions WHERE id = $1 FOR UPDATE",
      [sessionId]
    );
    if (sessionRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }
    if (sessionRes.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Session is already closed" });
    }
    if (buyInStatus === "approved" && sessionRes.rows[0].created_by !== actor.id) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the host can add an approved buy-in" });
    }
    // Auto-enroll as player if not already in session
    const existing = await client.query(
      "SELECT 1 AS existing FROM live_session_players WHERE session_id = $1 AND user_id = $2",
      [sessionId, userId]
    );
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO live_session_players
           (session_id, user_id, role, joined_at, commitment_type, commitment_locked_at)
         VALUES ($1, $2, 'player', NOW(), 'flexible', NOW())`,
        [sessionId, userId]
      );
      await client.query(
        `INSERT INTO live_attendance_events (session_id, user_id, event_type)
         VALUES ($1, $2, 'join')`,
        [sessionId, userId]
      );
    }
    if (buyInStatus === "pending") {
      const pending = await client.query(
        `SELECT 1
         FROM live_buy_ins
         WHERE session_id = $1 AND user_id = $2 AND status = 'pending'
         LIMIT 1`,
        [sessionId, userId]
      );
      if (pending.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "A buy-in request is already pending" });
      }
    }
    const buyInRes = await client.query(
      `INSERT INTO live_buy_ins (session_id, user_id, amount, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [sessionId, userId, amount, buyInStatus]
    );
    await client.query("COMMIT");
    res.status(201).json({ buyIn: buyInRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to create buy-in" });
  } finally {
    client.release();
  }
});

app.post("/api/live/session/settle", async (req, res) => {
  res.status(410).json({
    error: "Final chip counts are recorded through authenticated session finalization",
  });
});

app.post("/api/live/session/leave", async (req, res) => {
  const { sessionId, userId, outChips, adjustPlan } = req.body;
  if (!sessionId || !userId || outChips === undefined)
    return res.status(400).json({ error: "sessionId, userId and outChips are required" });
  if (typeof outChips !== 'number' || outChips < 0)
    return res.status(400).json({ error: "outChips must be a non-negative number" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sessRes = await client.query(
      "SELECT id, status FROM live_sessions WHERE id = $1 FOR UPDATE",
      [sessionId]
    );
    if (sessRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }
    if (sessRes.rows[0].status !== 'active') {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Session is already closed" });
    }

    const playerRes = await client.query(
      "SELECT user_id, left_at, leave_pending FROM live_session_players WHERE session_id = $1 AND user_id = $2",
      [sessionId, userId]
    );
    if (playerRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Player not found in session" });
    }
    if (playerRes.rows[0].left_at !== null) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Player has already left this session" });
    }
    if (playerRes.rows[0].leave_pending) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Leave request already pending" });
    }

    const result = await client.query(
      `UPDATE live_session_players
       SET leave_pending = TRUE,
           pending_out_chips = $1,
           pending_plan_adjustment = $2
       WHERE session_id = $3 AND user_id = $4
       RETURNING *`,
      [outChips, adjustPlan === true, sessionId, userId]
    );

    await client.query("COMMIT");
    res.json({ player: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to submit leave request" });
  } finally {
    client.release();
  }
});

app.post("/api/live/session/leave/approve", async (req, res) => {
  const { sessionId, userId } = req.body;
  if (!sessionId || !userId)
    return res.status(400).json({ error: "sessionId and userId are required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRes = await client.query(
      "SELECT status FROM live_sessions WHERE id = $1 FOR UPDATE",
      [sessionId]
    );
    if (sessionRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }
    if (sessionRes.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Session is already closed" });
    }
    const leftAt = new Date();
    const result = await client.query(
      `UPDATE live_session_players
       SET final_winnings = pending_out_chips,
           left_at = $1,
           leave_pending = FALSE,
           pending_out_chips = NULL,
           commitment_adjusted = commitment_adjusted OR pending_plan_adjustment,
           pending_plan_adjustment = FALSE
       WHERE session_id = $2 AND user_id = $3 AND leave_pending = TRUE
       RETURNING *`,
      [leftAt, sessionId, userId]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No pending leave request found" });
    }
    await client.query(
      `INSERT INTO live_attendance_events
        (session_id, user_id, event_type, occurred_at)
       VALUES ($1, $2, 'leave', $3)`,
      [sessionId, userId, leftAt]
    );
    await client.query("COMMIT");
    res.json({ player: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to approve leave request" });
  } finally {
    client.release();
  }
});

app.post("/api/live/session/leave/reject", async (req, res) => {
  const { sessionId, userId } = req.body;
  if (!sessionId || !userId)
    return res.status(400).json({ error: "sessionId and userId are required" });
  try {
    const result = await pool.query(
      `UPDATE live_session_players
       SET leave_pending = FALSE,
           pending_out_chips = NULL,
           pending_plan_adjustment = FALSE
       WHERE session_id = $1 AND user_id = $2
         AND EXISTS (
           SELECT 1 FROM live_sessions
           WHERE id = $1 AND status = 'active'
         )
       RETURNING *`,
      [sessionId, userId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Player not found in session" });
    res.json({ player: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to reject leave request" });
  }
});

app.post("/api/live/session/finalize", async (req, res) => {
  const { sessionId, results, endReason } = req.body;
  const allowedEndReasons = new Set(["completed", "table_break", "ended_early"]);
  if (!sessionId || !UUID_PATTERN.test(sessionId)) {
    return res.status(400).json({ error: "A valid sessionId is required" });
  }
  let actor: { id: string } | null;
  try {
    actor = await authenticateLiveRequest(req);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not authenticate finalization" });
  }
  if (!actor) {
    return res.status(401).json({ error: "Sign in again before finalizing" });
  }
  if (!Array.isArray(results) || results.length === 0 || results.length > 100) {
    return res.status(400).json({ error: "results must contain every player" });
  }
  if (!allowedEndReasons.has(endReason)) {
    return res.status(400).json({ error: "Invalid endReason" });
  }

  const normalized = results.map((result: any) => ({
    userId: typeof result?.userId === "string" ? result.userId : "",
    winnings: Number(result?.winnings),
  }));
  if (
    normalized.some(
      (result) =>
        !UUID_PATTERN.test(result.userId) ||
        !Number.isFinite(result.winnings) ||
        result.winnings < 0
    )
  ) {
    return res.status(400).json({ error: "Each result needs a valid player and chip count" });
  }
  if (new Set(normalized.map((result) => result.userId)).size !== normalized.length) {
    return res.status(400).json({ error: "Duplicate players are not allowed" });
  }
  const rawAttendanceEvents = req.body.attendanceEvents ?? [];
  if (!Array.isArray(rawAttendanceEvents) || rawAttendanceEvents.length > 500) {
    return res.status(400).json({ error: "attendanceEvents must contain at most 500 events" });
  }
  const attendanceEvents = rawAttendanceEvents.map((event: any) => ({
    id: typeof event?.id === "string" ? event.id : "",
    userId: typeof event?.userId === "string" ? event.userId : "",
    eventType: event?.eventType,
    occurredAt: new Date(event?.occurredAt),
  }));
  if (
    attendanceEvents.some(
      (event) =>
        !UUID_PATTERN.test(event.id) ||
        !UUID_PATTERN.test(event.userId) ||
        (event.eventType !== "pause" && event.eventType !== "resume") ||
        !Number.isFinite(event.occurredAt.getTime())
    )
  ) {
    return res.status(400).json({ error: "Invalid attendance event" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRes = await client.query(
      `SELECT id, status, created_at, created_by
       FROM live_sessions
       WHERE id = $1
       FOR UPDATE`,
      [sessionId]
    );
    if (sessionRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }
    if (sessionRes.rows[0].created_by !== actor.id) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the session host can finalize" });
    }
    if (sessionRes.rows[0].status === "closed") {
      const snapshot = await getLiveSessionSnapshot(client, sessionId);
      await client.query("COMMIT");
      return res.json(snapshot);
    }

    const playersRes = await client.query(
      "SELECT user_id FROM live_session_players WHERE session_id = $1",
      [sessionId]
    );
    const playerIds = new Set(playersRes.rows.map((row: any) => row.user_id));
    if (
      playerIds.size !== normalized.length ||
      normalized.some((result) => !playerIds.has(result.userId))
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Final chip counts must include every player once" });
    }
    const sessionStartedAt = new Date(sessionRes.rows[0].created_at).getTime();
    const latestAllowedAt = Date.now() + 5 * 60_000;
    if (
      attendanceEvents.some(
        (event) =>
          !playerIds.has(event.userId) ||
          event.occurredAt.getTime() < sessionStartedAt ||
          event.occurredAt.getTime() > latestAllowedAt
      )
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Attendance events fall outside this session" });
    }

    const poolRes = await client.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)::numeric AS total,
         COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending_count
       FROM live_buy_ins
       WHERE session_id = $1`,
      [sessionId]
    );
    if (Number(poolRes.rows[0].pending_count) > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Approve or reject every pending buy-in before finalizing",
      });
    }
    const totalBuyIns = Number(poolRes.rows[0].total);
    if (!Number.isFinite(totalBuyIns)) {
      await client.query("ROLLBACK");
      return res.status(422).json({ error: "Approved buy-ins contain an invalid amount" });
    }
    const totalWinnings = normalized.reduce((sum, result) => sum + result.winnings, 0);
    if (Math.abs(totalWinnings - totalBuyIns) > 0.1) {
      await client.query("ROLLBACK");
      return res.status(422).json({
        error: `Chips out (${totalWinnings}) must equal approved buy-ins (${totalBuyIns})`,
      });
    }

    await client.query(
      `UPDATE live_session_players AS player
       SET final_winnings = input.winnings
       FROM jsonb_to_recordset($1::jsonb)
         AS input("userId" UUID, winnings NUMERIC)
       WHERE player.session_id = $2
         AND player.user_id = input."userId"`,
      [JSON.stringify(normalized), sessionId]
    );
    if (attendanceEvents.length > 0) {
      await client.query(
        `INSERT INTO live_attendance_events
           (id, session_id, user_id, event_type, occurred_at)
         SELECT input.id, $2, input."userId", input."eventType", input."occurredAt"
         FROM jsonb_to_recordset($1::jsonb)
           AS input(
             id UUID,
             "userId" UUID,
             "eventType" TEXT,
             "occurredAt" TIMESTAMPTZ
           )
         ON CONFLICT (id) DO NOTHING`,
        [
          JSON.stringify(
            attendanceEvents.map((event) => ({
              ...event,
              occurredAt: event.occurredAt.toISOString(),
            }))
          ),
          sessionId,
        ]
      );
    }
    await client.query(
      `UPDATE live_sessions
       SET status = 'closed', closed_at = NOW(), end_reason = $1
       WHERE id = $2`,
      [endReason, sessionId]
    );
    const snapshot = await getLiveSessionSnapshot(client, sessionId);
    await client.query("COMMIT");
    res.json(snapshot);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to finalize session" });
  } finally {
    client.release();
  }
});

app.post("/api/live/session/status", async (req, res) => {
  res.status(410).json({
    error: "Use authenticated session finalization to close a session",
  });
});

// Parameterized session route — after specific sub-routes
app.get("/api/live/session/:idOrCode", async (req, res) => {
  const { idOrCode } = req.params;
  try {
    const snapshot = await getLiveSessionSnapshot(pool, idOrCode);
    if (!snapshot)
      return res.status(404).json({ error: "Session not found" });
    res.json(snapshot);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// Buy-in status update
app.patch("/api/live/buyin/:id", async (req, res) => {
  const { status } = req.body;
  if (!["approved", "rejected"].includes(status))
    return res.status(400).json({ error: "A valid status is required" });
  let actor: { id: string } | null;
  try {
    actor = await authenticateLiveRequest(req);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not authenticate buy-in update" });
  }
  if (!actor) return res.status(401).json({ error: "Sign in again to update buy-ins" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const buyIn = await client.query(
      `SELECT buy_in.session_id, live_session.status, live_session.created_by
       FROM live_buy_ins AS buy_in
       JOIN live_sessions AS live_session ON live_session.id = buy_in.session_id
       WHERE buy_in.id = $1
       FOR UPDATE OF live_session`,
      [req.params.id]
    );
    if (buyIn.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Buy-in not found" });
    }
    if (buyIn.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Session is already closed" });
    }
    if (buyIn.rows[0].created_by !== actor.id) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the session host can update buy-ins" });
    }
    const result = await client.query(
      "UPDATE live_buy_ins SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id]
    );
    await client.query("COMMIT");
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Buy-in not found" });
    res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to update buy-in" });
  } finally {
    client.release();
  }
});

// Per-user P&L stats
app.get("/api/live/stats/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    res.json(await getLiveUserStats(userId));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

export default app;
