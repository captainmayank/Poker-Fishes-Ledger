// ---------------------------------------------------------------------------
// liveApi — Thor live-session feature API client
// All routes are under /api/live/ to avoid colliding with Fishes routes.
// ---------------------------------------------------------------------------

import type { CommitmentType } from '../lib/playPlan';

const BASE = '/api/live';

// ── Types ───────────────────────────────────────────────────────────────────

export interface LiveUser {
  id: string;
  name: string;
  username: string;
  mobile?: string;
  authToken: string;
}

export interface LiveSession {
  id: string;
  name: string;
  sessionCode: string;
  createdBy: string;
  status: 'active' | 'closed';
  createdAt: number;
  closedAt?: number;
  plannedEndAt?: number;
  endReason?: 'completed' | 'table_break' | 'ended_early';
  blindValue?: string;
  publishedToLedger: boolean;
  publishedSessionId: number | null;
}

export interface LiveSessionPlayer {
  sessionId: string;
  userId: string;
  name: string;
  role: 'admin' | 'player';
  finalWinnings?: number;
  leftAt?: number;
  leavePending: boolean;
  pendingOutChips?: number;
  joinedAt: number;
  commitmentType: CommitmentType;
  commitmentStartAt?: number;
  commitmentEndAt?: number;
  commitmentAdjusted: boolean;
  pendingPlanAdjustment: boolean;
}

export interface LiveBuyIn {
  id: string;
  sessionId: string;
  userId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  timestamp: number;
}

export interface LiveSessionPLPoint {
  sessionId: string;
  sessionName: string;
  date: number;
  pl: number;
}

export interface LivePlayerStats {
  weeklyPL: number;
  monthlyPL: number;
  yearlyPL: number;
  totalPL: number;
  history?: LiveSessionPLPoint[];
}

export interface LiveSettlementTx {
  from: string;
  to: string;
  amount: number;
}

export interface LiveAttendanceEvent {
  id: string;
  sessionId: string;
  userId: string;
  eventType: 'join' | 'rejoin' | 'leave' | 'pause' | 'resume';
  occurredAt: number;
}

export interface LiveSessionSnapshot {
  session: LiveSession;
  players: LiveSessionPlayer[];
  buyIns: LiveBuyIn[];
  attendanceEvents: LiveAttendanceEvent[];
}

// ── Mappers ─────────────────────────────────────────────────────────────────

const mapUser = (u: any): LiveUser => ({
  id: u.id,
  name: u.name,
  username: u.username,
  mobile: u.mobile,
  authToken: u.authToken,
});

const mapSession = (s: any): LiveSession => ({
  id: s.id,
  name: s.name,
  sessionCode: s.session_code,
  createdBy: s.created_by,
  status: s.status,
  createdAt: new Date(s.created_at).getTime(),
  closedAt: s.closed_at ? new Date(s.closed_at).getTime() : undefined,
  plannedEndAt: s.planned_end_at ? new Date(s.planned_end_at).getTime() : undefined,
  endReason: s.end_reason,
  blindValue: s.blind_value,
  publishedToLedger: s.published_to_ledger === true,
  publishedSessionId:
    s.published_session_id == null ? null : Number(s.published_session_id),
});

const mapPlayer = (p: any): LiveSessionPlayer => ({
  sessionId: p.session_id,
  userId: p.user_id,
  name: p.name,
  role: p.role,
  finalWinnings: p.final_winnings != null ? parseFloat(p.final_winnings) : undefined,
  leftAt: p.left_at != null ? new Date(p.left_at).getTime() : undefined,
  leavePending: p.leave_pending === true || p.leave_pending === 't',
  pendingOutChips: p.pending_out_chips != null ? parseFloat(p.pending_out_chips) : undefined,
  joinedAt: p.joined_at ? new Date(p.joined_at).getTime() : 0,
  commitmentType: p.commitment_type ?? 'flexible',
  commitmentStartAt: p.commitment_start_at
    ? new Date(p.commitment_start_at).getTime()
    : undefined,
  commitmentEndAt: p.commitment_end_at
    ? new Date(p.commitment_end_at).getTime()
    : undefined,
  commitmentAdjusted: p.commitment_adjusted === true || p.commitment_adjusted === 't',
  pendingPlanAdjustment:
    p.pending_plan_adjustment === true || p.pending_plan_adjustment === 't',
});

const mapBuyIn = (b: any): LiveBuyIn => ({
  id: b.id,
  sessionId: b.session_id,
  userId: b.user_id,
  amount: parseFloat(b.amount),
  status: b.status,
  timestamp: new Date(b.timestamp).getTime(),
});

const mapAttendanceEvent = (event: any): LiveAttendanceEvent => ({
  id: event.id,
  sessionId: event.session_id,
  userId: event.user_id,
  eventType: event.event_type,
  occurredAt: new Date(event.occurred_at).getTime(),
});

const mapPlayerStats = (data: any): LivePlayerStats => {
  const history: LiveSessionPLPoint[] = Array.isArray(data.history)
    ? data.history.map((historyPoint: any) => ({
        sessionId: historyPoint.sessionId,
        sessionName: historyPoint.sessionName,
        date:
          typeof historyPoint.date === 'number'
            ? historyPoint.date
            : new Date(historyPoint.date).getTime(),
        pl:
          typeof historyPoint.pl === 'number'
            ? historyPoint.pl
            : parseFloat(historyPoint.pl),
      }))
    : [];
  return {
    weeklyPL: Number(data.weeklyPL) || 0,
    monthlyPL: Number(data.monthlyPL) || 0,
    yearlyPL: Number(data.yearlyPL) || 0,
    totalPL: Number(data.totalPL) || 0,
    history,
  };
};

const mapSnapshot = (data: any): LiveSessionSnapshot => ({
  session: mapSession(data.session),
  players: (data.players ?? []).map(mapPlayer),
  buyIns: (data.buyIns ?? []).map(mapBuyIn),
  attendanceEvents: (data.attendanceEvents ?? []).map(mapAttendanceEvent),
});

const sessionCache = new Map<string, LiveSessionSnapshot>();

function cacheSnapshot(snapshot: LiveSessionSnapshot) {
  sessionCache.set(snapshot.session.id, snapshot);
  sessionCache.set(snapshot.session.sessionCode.toUpperCase(), snapshot);
}

function takeCachedSnapshot(idOrCode: string): LiveSessionSnapshot | null {
  const snapshot = sessionCache.get(idOrCode) ?? sessionCache.get(idOrCode.toUpperCase());
  if (!snapshot) return null;
  sessionCache.delete(snapshot.session.id);
  sessionCache.delete(snapshot.session.sessionCode.toUpperCase());
  return snapshot;
}

// ── Generic fetch helper ─────────────────────────────────────────────────────

async function apiFetch<T>(
  url: string,
  options?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || `Error ${res.status}` };
      return { ok: true, data };
    }
    const text = await res.text();
    return { ok: false, error: `Server error (${res.status}): ${text.slice(0, 120)}` };
  } catch (e: any) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
}

// ── API object ───────────────────────────────────────────────────────────────

export const liveApi = {
  // Auth
  register: async (
    name: string,
    username: string,
    password: string
  ): Promise<{ success: boolean; user?: LiveUser; error?: string }> => {
    const r = await apiFetch<{ user: any }>(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, password }),
    });
    if (r.ok === false) return { success: false, error: r.error };
    return { success: true, user: mapUser(r.data.user) };
  },

  login: async (
    username: string,
    password: string
  ): Promise<{ success: boolean; user?: LiveUser; error?: string }> => {
    const r = await apiFetch<{ user: any }>(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (r.ok === false) return { success: false, error: r.error };
    return { success: true, user: mapUser(r.data.user) };
  },

  // Sessions
  getSessions: async (userId: string): Promise<LiveSession[]> => {
    const res = await fetch(`${BASE}/sessions?userId=${encodeURIComponent(userId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(mapSession);
  },

  getLobby: async (
    userId: string
  ): Promise<{ sessions: LiveSession[]; stats: LivePlayerStats } | null> => {
    const r = await apiFetch<any>(`${BASE}/lobby/${encodeURIComponent(userId)}`);
    if (r.ok === false) return null;
    return {
      sessions: (r.data.sessions ?? []).map(mapSession),
      stats: mapPlayerStats(r.data.stats ?? {}),
    };
  },

  createSession: async (
    name: string,
    blindValue: string,
    createdBy: string,
    plannedDurationMinutes: number,
    hostCommitmentType: CommitmentType = 'full',
    hostCommitmentMinutes?: number
  ): Promise<{ success: boolean; session?: LiveSession; error?: string }> => {
    const r = await apiFetch<any>(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        blindValue,
        createdBy,
        plannedDurationMinutes,
        hostCommitmentType,
        hostCommitmentMinutes,
      }),
    });
    if (r.ok === false) return { success: false, error: r.error };
    const snapshot = mapSnapshot(r.data);
    cacheSnapshot(snapshot);
    return { success: true, session: snapshot.session };
  },

  getSession: async (
    idOrCode: string
  ): Promise<LiveSessionSnapshot | null> => {
    const cached = takeCachedSnapshot(idOrCode);
    if (cached) return cached;
    const res = await fetch(`${BASE}/session/${encodeURIComponent(idOrCode)}`);
    if (!res.ok) return null;
    return mapSnapshot(await res.json());
  },

  joinSession: async (
    code: string,
    userId: string,
    role: 'admin' | 'player' = 'player',
    commitmentType: CommitmentType = 'flexible',
    commitmentMinutes?: number
  ): Promise<{
    success: boolean;
    error?: string;
    player?: LiveSessionPlayer;
    session?: LiveSession;
    sessionId?: string;
  }> => {
    const r = await apiFetch<any>(`${BASE}/session/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userId, role, commitmentType, commitmentMinutes }),
    });
    if (r.ok === false) return { success: false, error: r.error };
    const snapshot = mapSnapshot(r.data);
    cacheSnapshot(snapshot);
    return {
      success: true,
      player: snapshot.players.find((player) => player.userId === userId),
      session: snapshot.session,
      sessionId: snapshot.session.id,
    };
  },

  requestBuyIn: async (
    sessionId: string,
    userId: string,
    amount: number,
    authToken: string,
    status: 'pending' | 'approved' = 'pending'
  ): Promise<{ success: boolean; error?: string; buyIn?: LiveBuyIn }> => {
    const r = await apiFetch<{ buyIn: any }>(`${BASE}/session/buyin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ sessionId, userId, amount, status }),
    });
    if (r.ok === false) return { success: false, error: r.error };
    return { success: true, buyIn: mapBuyIn(r.data.buyIn) };
  },

  updateBuyInStatus: async (
    buyInId: string,
    status: 'approved' | 'rejected',
    authToken: string
  ): Promise<LiveBuyIn | null> => {
    const r = await apiFetch<any>(`${BASE}/buyin/${buyInId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ status }),
    });
    return r.ok ? mapBuyIn(r.data) : null;
  },

  updateSessionStatus: async (
    sessionId: string,
    status: 'active' | 'closed'
  ): Promise<boolean> => {
    const res = await fetch(`${BASE}/session/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, status }),
    });
    return res.ok;
  },

  settlePlayer: async (
    sessionId: string,
    userId: string,
    winnings: number
  ): Promise<boolean> => {
    const res = await fetch(`${BASE}/session/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, winnings }),
    });
    return res.ok;
  },

  leaveSession: async (
    sessionId: string,
    userId: string,
    outChips: number,
    adjustPlan: boolean
  ): Promise<{ success: boolean; error?: string; player?: LiveSessionPlayer }> => {
    const r = await apiFetch<{ player: any }>(`${BASE}/session/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, outChips, adjustPlan }),
    });
    if (r.ok === false) return { success: false, error: r.error };
    return { success: true, player: mapPlayer(r.data.player) };
  },

  approveLeave: async (
    sessionId: string,
    userId: string
  ): Promise<LiveSessionPlayer | null> => {
    const r = await apiFetch<{ player: any }>(`${BASE}/session/leave/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId }),
    });
    return r.ok ? mapPlayer(r.data.player) : null;
  },

  rejectLeave: async (
    sessionId: string,
    userId: string
  ): Promise<LiveSessionPlayer | null> => {
    const r = await apiFetch<{ player: any }>(`${BASE}/session/leave/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId }),
    });
    return r.ok ? mapPlayer(r.data.player) : null;
  },

  finalizeSession: async (
    sessionId: string,
    results: Array<{ userId: string; winnings: number }>,
    endReason: 'completed' | 'table_break' | 'ended_early',
    attendanceEvents: LiveAttendanceEvent[],
    authToken: string
  ): Promise<{ success: boolean; error?: string; snapshot?: LiveSessionSnapshot }> => {
    const r = await apiFetch<any>(`${BASE}/session/finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ sessionId, results, endReason, attendanceEvents }),
    });
    if (r.ok === false) return { success: false, error: r.error };
    const snapshot = mapSnapshot(r.data);
    cacheSnapshot(snapshot);
    return { success: true, snapshot };
  },

  publishToLedger: async (
    sessionId: string
  ): Promise<
    | { success: true; fishesSessionId: number; alreadyPublished?: boolean }
    | { success: false; error: string }
  > => {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await res.json() : {};
    if (res.status === 409 && body.alreadyPublished) {
      return {
        success: true,
        fishesSessionId: Number(body.fishesSessionId) || 0,
        alreadyPublished: true,
      };
    }
    if (!res.ok) {
      return { success: false, error: body.error || `Publish failed (${res.status})` };
    }
    return { success: true, fishesSessionId: Number(body.fishesSessionId) };
  },

  getUserStats: async (userId: string): Promise<LivePlayerStats> => {
    const res = await fetch(`${BASE}/stats/${encodeURIComponent(userId)}`);
    if (!res.ok) return { weeklyPL: 0, monthlyPL: 0, yearlyPL: 0, totalPL: 0, history: [] };
    return mapPlayerStats(await res.json());
  },
};
