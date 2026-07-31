import { describe, expect, it } from 'vitest';
import { buildAttendanceIntervals, scorePlayPlan } from './playPlan';

const minute = 60_000;
const at = (minutes: number) => minutes * minute;

describe('scorePlayPlan', () => {
  it('marks a completed commitment as on plan', () => {
    const result = scorePlayPlan({
      commitmentType: 'full',
      commitmentStartAt: at(0),
      commitmentEndAt: at(240),
      sessionStartAt: at(0),
      sessionEndAt: at(240),
      attendance: [{ startAt: at(0), endAt: at(240) }],
    });

    describe('buildAttendanceIntervals', () => {
      it('keeps multiple join/leave segments and closes an open seat at session end', () => {
        const intervals = buildAttendanceIntervals(
          [
            { userId: 'a', eventType: 'join', occurredAt: at(0) },
            { userId: 'a', eventType: 'leave', occurredAt: at(60) },
            { userId: 'a', eventType: 'rejoin', occurredAt: at(90) },
          ],
          'a',
          at(180)
        );

        expect(intervals).toEqual([
          { startAt: at(0), endAt: at(60) },
          { startAt: at(90), endAt: at(180) },
        ]);
      });

      it('subtracts a recorded break from active play time', () => {
        const intervals = buildAttendanceIntervals(
          [
            { userId: 'a', eventType: 'join', occurredAt: at(0) },
            { userId: 'a', eventType: 'pause', occurredAt: at(60) },
            { userId: 'a', eventType: 'resume', occurredAt: at(75) },
          ],
          'a',
          at(135)
        );
        const score = scorePlayPlan({
          commitmentType: 'full',
          commitmentStartAt: at(0),
          commitmentEndAt: at(135),
          sessionStartAt: at(0),
          sessionEndAt: at(135),
          attendance: intervals,
        });

        expect(score.attendedMinutes).toBe(120);
        expect(score.coverage).toBeCloseTo(120 / 135);
      });
    });

    expect(result.status).toBe('on_plan');
    expect(result.fulfillment).toBe(1);
    expect(result.attendedMinutes).toBe(240);
  });

  it('scores an unexplained early departure without using poker results', () => {
    const result = scorePlayPlan({
      commitmentType: 'custom',
      commitmentStartAt: at(0),
      commitmentEndAt: at(240),
      sessionStartAt: at(0),
      sessionEndAt: at(240),
      attendance: [{ startAt: at(0), endAt: at(120) }],
    });

    expect(result.status).toBe('incomplete');
    expect(result.coverage).toBe(0.5);
    expect(result.earlyMinutes).toBe(105);
  });

  it('truncates every plan when the table ends early', () => {
    const result = scorePlayPlan({
      commitmentType: 'full',
      commitmentStartAt: at(0),
      commitmentEndAt: at(240),
      sessionStartAt: at(0),
      sessionEndAt: at(150),
      attendance: [{ startAt: at(0), endAt: at(150) }],
    });

    expect(result.status).toBe('on_plan');
    expect(result.plannedMinutes).toBe(150);
  });

  it('keeps flexible plans unscored', () => {
    const result = scorePlayPlan({
      commitmentType: 'flexible',
      sessionStartAt: at(0),
      sessionEndAt: at(240),
      attendance: [{ startAt: at(0), endAt: at(240) }],
    });

    expect(result.status).toBe('flexible');
    expect(result.fulfillment).toBeNull();
  });

  it('labels a host-approved adjustment without treating it as a failure', () => {
    const result = scorePlayPlan({
      commitmentType: 'full',
      commitmentStartAt: at(0),
      commitmentEndAt: at(240),
      sessionStartAt: at(0),
      sessionEndAt: at(240),
      attendance: [{ startAt: at(0), endAt: at(120) }],
      adjusted: true,
    });

    expect(result.status).toBe('plan_changed');
    expect(result.fulfillment).toBe(1);
  });

  it('combines re-entry intervals and counts the gap against coverage', () => {
    const result = scorePlayPlan({
      commitmentType: 'full',
      commitmentStartAt: at(0),
      commitmentEndAt: at(240),
      sessionStartAt: at(0),
      sessionEndAt: at(240),
      attendance: [
        { startAt: at(0), endAt: at(90) },
        { startAt: at(120), endAt: at(240) },
      ],
    });

    expect(result.status).toBe('on_plan');
    expect(result.coverage).toBeCloseTo(0.875);
    expect(result.fulfillment).toBeCloseTo(0.9375);
  });

  it('returns needs review when attendance evidence is missing', () => {
    const result = scorePlayPlan({
      commitmentType: 'full',
      commitmentStartAt: at(0),
      commitmentEndAt: at(240),
      sessionStartAt: at(0),
      sessionEndAt: at(240),
      attendance: [],
    });

    expect(result.status).toBe('needs_review');
  });
});
