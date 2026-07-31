export type AttendanceConfidence = 'high' | 'medium';

export interface PokerNowAttendance {
  externalId: string;
  name: string;
  joinedAt: string;
  leftAt: string;
  durationMinutes: number;
  handCount: number;
  confidence: AttendanceConfidence;
}

interface LogRow {
  entry: string;
  at: number;
  order: number;
}

interface PlayerHands {
  externalId: string;
  name: string;
  segments: Array<{ startAt: number; endAt: number }>;
  incompleteHand: boolean;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseIdentity(value: string): { externalId: string; name: string } | null {
  const separator = value.lastIndexOf(' @ ');
  if (separator < 1) return null;
  const name = value.slice(0, separator).trim();
  const externalId = value.slice(separator + 3).trim();
  if (!name || !/^[A-Za-z0-9_-]+$/.test(externalId)) return null;
  return { externalId, name };
}

function getEvidence(
  players: Map<string, PlayerHands>,
  identity: { externalId: string; name: string }
): PlayerHands {
  const existing = players.get(identity.externalId);
  if (existing) {
    existing.name = identity.name;
    return existing;
  }
  const created: PlayerHands = {
    ...identity,
    segments: [],
    incompleteHand: false,
  };
  players.set(identity.externalId, created);
  return created;
}

function stackPlayers(entry: string): Array<{ externalId: string; name: string }> {
  if (!entry.startsWith('Player stacks:')) return [];
  const matches = entry.matchAll(/"((?:[^"]|"")*? @ [A-Za-z0-9_-]+)"\s*\(/g);
  return Array.from(matches)
    .map((match) => parseIdentity(match[1].replaceAll('""', '"')))
    .filter((identity): identity is { externalId: string; name: string } => identity !== null);
}

function toRows(text: string): LogRow[] {
  const rows = parseCsv(text);
  const header = rows[0]?.map((column) => column.trim().toLowerCase());
  if (
    !header ||
    header[0] !== 'entry' ||
    header[1] !== 'at' ||
    header[2] !== 'order'
  ) {
    throw new Error('This is not a PokerNow Game Log CSV.');
  }

  return rows
    .slice(1)
    .map((row) => ({
      entry: row[0] ?? '',
      at: Date.parse(row[1] ?? ''),
      order: Number(row[2]),
    }))
    .filter((row) => row.entry && Number.isFinite(row.at) && Number.isFinite(row.order))
    .sort((a, b) => a.at - b.at || a.order - b.order);
}

export function isPokerNowGameLog(text: string): boolean {
  try {
    const rows = toRows(text);
    return rows.some(
      (row) =>
        row.entry.startsWith('Player stacks:') ||
        /joined the game|quits the game|stand(?:s)? up|sit(?:s)? back/i.test(row.entry)
    );
  } catch {
    return false;
  }
}

export function parsePokerNowGameLog(
  text: string,
  window?: { startAt?: number; endAt?: number }
): PokerNowAttendance[] {
  const rows = toRows(text);
  const players = new Map<string, PlayerHands>();
  let currentHand:
    | {
        startAt: number;
        players: Array<{ externalId: string; name: string }>;
      }
    | undefined;

  for (const row of rows) {
    if (/^-- starting hand #/i.test(row.entry)) {
      if (currentHand) {
        for (const identity of currentHand.players) {
          getEvidence(players, identity).incompleteHand = true;
        }
      }
      currentHand = { startAt: row.at, players: [] };
      continue;
    }
    if (currentHand && row.entry.startsWith('Player stacks:')) {
      currentHand.players = stackPlayers(row.entry);
      continue;
    }
    if (/^-- ending hand #/i.test(row.entry) && currentHand) {
      const inWindow =
        (window?.startAt == null || currentHand.startAt >= window.startAt) &&
        (window?.endAt == null || row.at <= window.endAt);
      if (row.at > currentHand.startAt && inWindow) {
        for (const identity of currentHand.players) {
          getEvidence(players, identity).segments.push({
            startAt: currentHand.startAt,
            endAt: row.at,
          });
        }
      } else if (inWindow) {
        for (const identity of currentHand.players) {
          getEvidence(players, identity).incompleteHand = true;
        }
      }
      currentHand = undefined;
    }
  }

  if (
    currentHand &&
    (window?.startAt == null || currentHand.startAt >= window.startAt) &&
    (window?.endAt == null || currentHand.startAt <= window.endAt)
  ) {
    for (const identity of currentHand.players) {
      getEvidence(players, identity).incompleteHand = true;
    }
  }
  const attendance: PokerNowAttendance[] = [];

  for (const player of players.values()) {
    if (player.segments.length === 0) continue;
    const durationMinutes = player.segments.reduce(
      (total, segment) => total + (segment.endAt - segment.startAt) / 60_000,
      0
    );
    attendance.push({
      externalId: player.externalId,
      name: player.name,
      joinedAt: new Date(player.segments[0].startAt).toISOString(),
      leftAt: new Date(
        player.segments[player.segments.length - 1].endAt
      ).toISOString(),
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      handCount: player.segments.length,
      confidence: player.incompleteHand ? 'medium' : 'high',
    });
  }

  return attendance.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}
