export type CommitmentType = 'full' | 'custom' | 'flexible';

export type PlayPlanStatus =
  | 'in_progress'
  | 'on_plan'
  | 'mostly_on_plan'
  | 'incomplete'
  | 'plan_changed'
  | 'flexible'
  | 'needs_review';

export interface AttendanceInterval {
  startAt: number;
  endAt: number;
}

export interface AttendanceEventLike {
  userId: string;
  eventType: 'join' | 'rejoin' | 'leave' | 'pause' | 'resume';
  occurredAt: number;
}

export interface PlayPlanScoreInput {
  commitmentType: CommitmentType;
  commitmentStartAt?: number;
  commitmentEndAt?: number;
  sessionStartAt: number;
  sessionEndAt?: number;
  attendance: AttendanceInterval[];
  adjusted?: boolean;
  graceMinutes?: number;
}

export interface PlayPlanScore {
  status: PlayPlanStatus;
  fulfillment: number | null;
  plannedMinutes: number;
  attendedMinutes: number;
  coverage: number | null;
  lateMinutes: number;
  earlyMinutes: number;
}

const MINUTE = 60_000;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function normalizeIntervals(intervals: AttendanceInterval[]): AttendanceInterval[] {
  const sorted = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startAt) &&
        Number.isFinite(interval.endAt) &&
        interval.endAt > interval.startAt
    )
    .sort((a, b) => a.startAt - b.startAt);

  const merged: AttendanceInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startAt > previous.endAt) {
      merged.push({ ...interval });
    } else {
      previous.endAt = Math.max(previous.endAt, interval.endAt);
    }
  }
  return merged;
}

export function buildAttendanceIntervals(
  events: AttendanceEventLike[],
  userId: string,
  sessionEndAt: number | undefined,
  fallbackStartAt?: number,
  fallbackEndAt?: number
): AttendanceInterval[] {
  const intervals: AttendanceInterval[] = [];
  let openAt: number | null = null;

  for (const event of events
    .filter((candidate) => candidate.userId === userId)
    .sort((a, b) => a.occurredAt - b.occurredAt)) {
    if (
      event.eventType === 'join' ||
      event.eventType === 'rejoin' ||
      event.eventType === 'resume'
    ) {
      if (openAt === null) openAt = event.occurredAt;
    } else if (openAt !== null && event.occurredAt > openAt) {
      intervals.push({ startAt: openAt, endAt: event.occurredAt });
      openAt = null;
    }
  }

  if (openAt !== null && sessionEndAt && sessionEndAt > openAt) {
    intervals.push({ startAt: openAt, endAt: sessionEndAt });
  }
  if (
    intervals.length === 0 &&
    fallbackStartAt != null &&
    (fallbackEndAt ?? sessionEndAt) != null &&
    (fallbackEndAt ?? sessionEndAt)! > fallbackStartAt
  ) {
    intervals.push({
      startAt: fallbackStartAt,
      endAt: (fallbackEndAt ?? sessionEndAt)!,
    });
  }
  return normalizeIntervals(intervals);
}

function overlapMinutes(
  intervals: AttendanceInterval[],
  expectedStart: number,
  expectedEnd: number
): number {
  return intervals.reduce((total, interval) => {
    const start = Math.max(interval.startAt, expectedStart);
    const end = Math.min(interval.endAt, expectedEnd);
    return total + Math.max(0, end - start) / MINUTE;
  }, 0);
}

export function scorePlayPlan(input: PlayPlanScoreInput): PlayPlanScore {
  if (input.commitmentType === 'flexible') {
    return {
      status: 'flexible',
      fulfillment: null,
      plannedMinutes: 0,
      attendedMinutes: 0,
      coverage: null,
      lateMinutes: 0,
      earlyMinutes: 0,
    };
  }

  if (
    input.sessionEndAt == null ||
    input.commitmentStartAt == null ||
    input.commitmentEndAt == null
  ) {
    return {
      status: input.sessionEndAt ? 'needs_review' : 'in_progress',
      fulfillment: null,
      plannedMinutes: 0,
      attendedMinutes: 0,
      coverage: null,
      lateMinutes: 0,
      earlyMinutes: 0,
    };
  }

  const attendance = normalizeIntervals(input.attendance);
  if (attendance.length === 0) {
    return {
      status: 'needs_review',
      fulfillment: null,
      plannedMinutes: 0,
      attendedMinutes: 0,
      coverage: null,
      lateMinutes: 0,
      earlyMinutes: 0,
    };
  }

  const expectedStart = Math.max(input.commitmentStartAt, input.sessionStartAt);
  const recordedDeparture = attendance[attendance.length - 1].endAt;
  const adjustedCommitmentEnd = input.adjusted
    ? Math.min(input.commitmentEndAt, recordedDeparture)
    : input.commitmentEndAt;
  const expectedEnd = Math.min(adjustedCommitmentEnd, input.sessionEndAt);

  if (expectedEnd <= expectedStart) {
    return {
      status: 'needs_review',
      fulfillment: null,
      plannedMinutes: 0,
      attendedMinutes: 0,
      coverage: null,
      lateMinutes: 0,
      earlyMinutes: 0,
    };
  }

  const plannedMinutes = (expectedEnd - expectedStart) / MINUTE;
  const attendedMinutes = overlapMinutes(attendance, expectedStart, expectedEnd);
  const grace = (input.graceMinutes ?? 15) * MINUTE;
  const firstArrival = attendance[0].startAt;
  const lastDeparture = attendance[attendance.length - 1].endAt;
  const lateMinutes = Math.max(0, firstArrival - expectedStart - grace) / MINUTE;
  const earlyMinutes = Math.max(0, expectedEnd - lastDeparture - grace) / MINUTE;
  const coverage = clamp(attendedMinutes / plannedMinutes, 0, 1);
  const arrival = clamp(1 - lateMinutes / 30, 0, 1);
  const departure = clamp(1 - earlyMinutes / 30, 0, 1);
  const fulfillment = 0.25 * arrival + 0.5 * coverage + 0.25 * departure;

  let status: PlayPlanStatus;
  if (input.adjusted && fulfillment >= 0.9) {
    status = 'plan_changed';
  } else if (fulfillment >= 0.9 && lateMinutes === 0 && earlyMinutes === 0) {
    status = 'on_plan';
  } else if (fulfillment >= 0.75) {
    status = 'mostly_on_plan';
  } else {
    status = 'incomplete';
  }

  return {
    status,
    fulfillment,
    plannedMinutes,
    attendedMinutes,
    coverage,
    lateMinutes,
    earlyMinutes,
  };
}

export const PLAY_PLAN_LABELS: Record<PlayPlanStatus, string> = {
  in_progress: 'In progress',
  on_plan: 'On plan',
  mostly_on_plan: 'Mostly on plan',
  incomplete: 'Incomplete',
  plan_changed: 'Plan changed',
  flexible: 'Flexible',
  needs_review: 'Needs review',
};
