import { describe, expect, it } from 'vitest';
import {
  calculatePokerNowResults,
  parsePokerNowGameUrl,
  parsePokerNowLedger,
} from '../../api/lib/pokerNow';

describe('parsePokerNowGameUrl', () => {
  it('accepts current and legacy game links and canonicalizes the host', () => {
    expect(
      parsePokerNowGameUrl('https://www.pokernow.club/games/pglAbc_123')
    ).toEqual({
      gameId: 'pglAbc_123',
      gameUrl: 'https://www.pokernow.com/games/pglAbc_123',
    });
  });

  it('rejects non-PokerNow hosts and non-game paths', () => {
    expect(() =>
      parsePokerNowGameUrl('https://example.com/games/pglAbc')
    ).toThrow('Only pokernow.com');
    expect(() => parsePokerNowGameUrl('https://pokernow.com/blog/pglAbc')).toThrow(
      'must point to a PokerNow game'
    );
  });
});

describe('parsePokerNowLedger', () => {
  it('uses stable IDs, latest names, and integer minor-unit net values', () => {
    expect(
      parsePokerNowLedger({
        playersInfos: {
          player1: { names: ['Old name', 'Alice'], net: 12345 },
        },
      })
    ).toEqual([
      { externalId: 'player1', name: 'Alice', netMinor: 12345 },
    ]);
  });
});

describe('calculatePokerNowResults', () => {
  it('subtracts the start baseline and converts hundredths for display', () => {
    const results = calculatePokerNowResults(
      [{ externalId: 'a', name: 'Alice', netMinor: 5000 }],
      [
        { externalId: 'a', name: 'Alice', netMinor: 12500 },
        { externalId: 'b', name: 'Bob', netMinor: -7500 },
      ],
      [],
      true
    );

    expect(results).toEqual([
      { externalId: 'a', name: 'Alice', amount: 75 },
      { externalId: 'b', name: 'Bob', amount: -75 },
    ]);
  });

  it('drops inactive historical ledger players but keeps dealt-in break-even players', () => {
    const results = calculatePokerNowResults(
      [
        { externalId: 'old', name: 'Old', netMinor: 1000 },
        { externalId: 'even', name: 'Even', netMinor: 0 },
      ],
      [
        { externalId: 'old', name: 'Old', netMinor: 1000 },
        { externalId: 'even', name: 'Even', netMinor: 0 },
      ],
      [{ externalId: 'even', name: 'Even' }],
      true
    );

    expect(results).toEqual([
      { externalId: 'even', name: 'Even', amount: 0 },
    ]);
  });

  it('keeps whole-chip values unscaled when cents mode is disabled', () => {
    expect(
      calculatePokerNowResults(
        [{ externalId: 'a', name: 'Alice', netMinor: 50 }],
        [{ externalId: 'a', name: 'Alice', netMinor: 125 }],
        [],
        false
      )
    ).toEqual([{ externalId: 'a', name: 'Alice', amount: 75 }]);
  });
});
