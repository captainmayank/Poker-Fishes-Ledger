export interface PublishSessionInput {
  id: string;
  name: string;
  status: 'active' | 'closed';
  closedAt: Date | string | null;
  publishedToLedger: boolean;
  publishedSessionId: number | null;
}

export interface PublishPlayerInput {
  userId: string;
  name: string;
  finalWinnings: number | null;
}

export interface PublishBuyInInput {
  userId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
}

export interface FishesResultRow {
  name: string;
  amount: number;
}

export interface FishesSessionPayload {
  date: string;
  note: string;
  results: FishesResultRow[];
}

export type PublishValidationError =
  | { code: 'already_published'; fishesSessionId: number }
  | { code: 'not_closed'; message: string }
  | { code: 'pending_buyins'; message: string }
  | { code: 'missing_winnings'; message: string };

export type PublishValidation =
  | { ok: true; payload: FishesSessionPayload; error?: never }
  | { ok: false; error: PublishValidationError; payload?: never };

const KOLKATA_OFFSET_MIN = 5 * 60 + 30;

function toKolkataDate(value: Date | string | null): string {
  const base = value ? new Date(value) : new Date();
  const shifted = new Date(base.getTime() + KOLKATA_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function buildFishesPayload(
  session: PublishSessionInput,
  players: PublishPlayerInput[],
  buyIns: PublishBuyInInput[]
): PublishValidation {
  if (session.publishedToLedger) {
    return {
      ok: false,
      error: {
        code: 'already_published',
        fishesSessionId: session.publishedSessionId ?? 0,
      },
    };
  }
  if (session.status !== 'closed') {
    return {
      ok: false,
      error: { code: 'not_closed', message: 'Session must be closed before publishing.' },
    };
  }
  if (buyIns.some(b => b.status === 'pending')) {
    return {
      ok: false,
      error: {
        code: 'pending_buyins',
        message: 'Approve or reject all pending buy-ins before publishing.',
      },
    };
  }
  const missing = players.filter(p => p.finalWinnings == null);
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'missing_winnings',
        message: `Record final winnings for all players before publishing (missing: ${missing
          .map(m => m.name)
          .join(', ')}).`,
      },
    };
  }

  const approvedByUser = new Map<string, number>();
  for (const b of buyIns) {
    if (b.status !== 'approved') continue;
    approvedByUser.set(b.userId, (approvedByUser.get(b.userId) ?? 0) + b.amount);
  }

  const results: FishesResultRow[] = players.map(p => {
    const buyIn = approvedByUser.get(p.userId) ?? 0;
    const winnings = p.finalWinnings ?? 0;
    return { name: p.name, amount: winnings - buyIn };
  });

  return {
    ok: true,
    payload: {
      date: toKolkataDate(session.closedAt),
      note: session.name,
      results,
    },
  };
}
