export interface PokerNowLedgerPlayer {
  externalId: string;
  name: string;
  netMinor: number;
}

export interface PokerNowResult {
  externalId: string;
  name: string;
  amount: number;
}

export function parsePokerNowGameUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('PokerNow game link is required');
  }
  const candidate = /^https?:\/\//i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Enter a valid PokerNow game link');
  }
  const allowedHosts = new Set([
    'pokernow.com',
    'www.pokernow.com',
    'pokernow.club',
    'www.pokernow.club',
  ]);
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('Only pokernow.com game links are supported');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'games' || !/^pgl[A-Za-z0-9_-]+$/.test(parts[1] ?? '')) {
    throw new Error('The link must point to a PokerNow game');
  }
  const gameId = parts[1];
  return {
    gameId,
    gameUrl: `https://www.pokernow.com/games/${gameId}`,
  };
}

export function parsePokerNowLedger(payload: unknown): PokerNowLedgerPlayer[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('PokerNow returned an invalid ledger');
  }
  const playersInfos = (payload as { playersInfos?: unknown }).playersInfos;
  if (!playersInfos || typeof playersInfos !== 'object' || Array.isArray(playersInfos)) {
    throw new Error('PokerNow returned an invalid ledger');
  }
  const entries = Object.entries(playersInfos as Record<string, any>);
  if (entries.length > 1000) {
    throw new Error('PokerNow ledger contains too many players');
  }
  return entries.map(([externalId, raw]) => {
    const names: string[] = Array.isArray(raw?.names)
      ? raw.names.filter(
          (name: unknown): name is string =>
            typeof name === 'string' && name.trim().length > 0
        )
      : [];
    const netMinor = Number(raw?.net);
    if (!/^[A-Za-z0-9_-]+$/.test(externalId) || !Number.isFinite(netMinor)) {
      throw new Error('PokerNow returned an invalid player ledger');
    }
    return {
      externalId,
      name: names[names.length - 1]?.trim() || externalId,
      netMinor,
    };
  });
}

export function calculatePokerNowResults(
  baseline: PokerNowLedgerPlayer[],
  finalLedger: PokerNowLedgerPlayer[],
  attendance: Array<{ externalId: string; name: string }>,
  centsMode: boolean
): PokerNowResult[] {
  const baselineById = new Map(
    baseline.map((player) => [player.externalId, player])
  );
  const finalById = new Map(
    finalLedger.map((player) => [player.externalId, player])
  );
  const attendanceById = new Map(
    attendance.map((player) => [player.externalId, player])
  );
  const playerIds = new Set([
    ...baselineById.keys(),
    ...finalById.keys(),
    ...attendanceById.keys(),
  ]);

  return Array.from(playerIds)
    .map((externalId) => {
      const before = baselineById.get(externalId);
      const after = finalById.get(externalId);
      const evidence = attendanceById.get(externalId);
      return {
        externalId,
        name: after?.name || before?.name || evidence?.name || externalId,
        amount:
          Math.round((after?.netMinor ?? 0) - (before?.netMinor ?? 0)) /
          (centsMode ? 100 : 1),
      };
    })
    .filter(
      (result) =>
        Math.abs(result.amount) >= 0.01 || attendanceById.has(result.externalId)
    );
}
