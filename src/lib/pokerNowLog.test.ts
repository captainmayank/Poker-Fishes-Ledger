import { describe, expect, it } from 'vitest';
import { isPokerNowGameLog, parsePokerNowGameLog } from './pokerNowLog';

describe('parsePokerNowGameLog', () => {
  it('sums time only for completed hands where the player appears in Player stacks', () => {
    const csv = `entry,at,order
"-- ending hand #2 --",2026-07-30T13:30:00.000Z,6
"Player stacks: #1 ""Alice @ abc123"" (80)",2026-07-30T13:00:00.000Z,5
"-- starting hand #2 (No Limit Texas Hold'em) --",2026-07-30T13:00:00.000Z,4
"-- ending hand #1 --",2026-07-30T12:30:00.000Z,3
"Player stacks: #1 ""Alice @ abc123"" (50)",2026-07-30T12:00:00.000Z,2
"-- starting hand #1 (No Limit Texas Hold'em) --",2026-07-30T12:00:00.000Z,1`;

    const [alice] = parsePokerNowGameLog(csv);
    expect(alice).toMatchObject({
      externalId: 'abc123',
      name: 'Alice',
      durationMinutes: 60,
      handCount: 2,
      confidence: 'high',
    });
  });

  it('does not count hands where the player is not dealt in', () => {
    const csv = `entry,at,order
"-- ending hand #2 --",2026-07-30T13:30:00.000Z,6
"Player stacks: #1 ""Bob @ def456"" (80)",2026-07-30T13:00:00.000Z,5
"-- starting hand #2 --",2026-07-30T13:00:00.000Z,4
"-- ending hand #1 --",2026-07-30T12:30:00.000Z,3
"Player stacks: #1 ""Alice @ abc123"" (50)",2026-07-30T12:00:00.000Z,2
"-- starting hand #1 --",2026-07-30T12:00:00.000Z,1`;

    const [alice] = parsePokerNowGameLog(csv);
    expect(alice.durationMinutes).toBe(30);
    expect(alice.handCount).toBe(1);
  });

  it('flags a player with an incomplete final hand as medium confidence', () => {
    const csv = `entry,at,order
"Player stacks: #1 ""Bob @ hash_2"" (75)",2026-07-30T13:00:00.000Z,5
"-- starting hand #2 --",2026-07-30T13:00:00.000Z,4
"-- ending hand #1 --",2026-07-30T12:30:00.000Z,3
"Player stacks: #1 ""Bob @ hash_2"" (50)",2026-07-30T12:00:00.000Z,2
"-- starting hand #1 --",2026-07-30T12:00:00.000Z,1`;

    const [bob] = parsePokerNowGameLog(csv);
    expect(bob.durationMinutes).toBe(30);
    expect(bob.handCount).toBe(1);
    expect(bob.confidence).toBe('medium');
  });

  it('filters completed hands to the tracked session window', () => {
    const csv = `entry,at,order
"-- ending hand #2 --",2026-07-30T13:30:00.000Z,6
"Player stacks: #1 ""Alice @ abc123"" (80)",2026-07-30T13:00:00.000Z,5
"-- starting hand #2 --",2026-07-30T13:00:00.000Z,4
"-- ending hand #1 --",2026-07-30T12:30:00.000Z,3
"Player stacks: #1 ""Alice @ abc123"" (50)",2026-07-30T12:00:00.000Z,2
"-- starting hand #1 --",2026-07-30T12:00:00.000Z,1`;

    const [alice] = parsePokerNowGameLog(csv, {
      startAt: Date.parse('2026-07-30T12:45:00.000Z'),
    });
    expect(alice.handCount).toBe(1);
    expect(alice.durationMinutes).toBe(30);
  });

  it('detects PokerNow logs and rejects unrelated CSVs', () => {
    expect(
      isPokerNowGameLog(
        'entry,at,order\n"-- starting hand #1 --",2026-07-30T12:00:00Z,1\n"Player stacks: #1 ""A @ id1"" (10)",2026-07-30T12:00:00Z,2'
      )
    ).toBe(true);
    expect(isPokerNowGameLog('name,amount\nAlice,100')).toBe(false);
    expect(() => parsePokerNowGameLog('name,amount\nAlice,100')).toThrow(
      'not a PokerNow Game Log'
    );
  });
});
