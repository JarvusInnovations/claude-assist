/**
 * Domain types for the weekly adaptive training loop.
 *
 * Deliberately sport-agnostic and goal-agnostic: the module knows how to
 * synthesize *a week of sessions* from activity history, a forecast, and
 * calendar availability. What the owner is training FOR is instance data —
 * it arrives as free-text `goalContext` config (see TrainingPluginConfig) and
 * is never encoded here.
 */

/** The shape of a session, not its intensity. */
export type SessionKind = 'run' | 'cross' | 'strength' | 'mobility' | 'rest' | 'race';

/** Whether the forecast pushes this session indoors. */
export type SessionVenue = 'indoor' | 'outdoor' | 'either';

export interface PlannedSession {
  /** ISO date (YYYY-MM-DD) inside the plan week. */
  date: string;
  kind: SessionKind;
  /** Short imperative title, e.g. "Easy run 3 mi". */
  title: string;
  /** Structure/pace/effort in one line. */
  detail: string;
  /** Planned distance in miles; null when the session isn't distance-shaped. */
  distanceMiles: number | null;
  /** Planned duration in minutes; null when unspecified. */
  durationMinutes: number | null;
  /** Why this session, this day — grounded in the input snapshot. */
  why: string;
  venue: SessionVenue;
}

/** Rolled-up activity history — what actually happened, not what was planned. */
export interface ActivitySummary {
  /** Trailing window the summary covers. */
  windowDays: number;
  totalCount: number;
  bySport: Array<{
    sport: string;
    count: number;
    distanceMiles: number;
    movingMinutes: number;
  }>;
  /** Most recent weeks first. */
  weekly: Array<{
    weekStart: string;
    runMiles: number;
    runCount: number;
    crossCount: number;
    crossMinutes: number;
  }>;
  longestRunMiles: number;
  /** Null when no run appears in the window at all. */
  daysSinceLastRun: number | null;
  /** Non-null when the history source was unavailable. */
  error: string | null;
}

export interface ForecastDay {
  date: string;
  /** Provider phrase, e.g. "Partly sunny". */
  summary: string;
  highF: number | null;
  lowF: number | null;
  /** 0–100, or null when the provider didn't say. */
  precipProbability: number | null;
}

export interface WeatherSummary {
  days: ForecastDay[];
  error: string | null;
}

export interface AvailabilityDay {
  date: string;
  meetingCount: number;
  busyMinutes: number;
  /** Local hour (0–23) the first timed meeting starts; null when the day is clear. */
  firstMeetingHour: number | null;
  /** Local hour the last timed meeting ends; null when the day is clear. */
  lastMeetingEndHour: number | null;
  /** All-day event titles — travel/PTO reads very differently from a busy day. */
  allDayNotes: string[];
}

export interface AvailabilitySummary {
  days: AvailabilityDay[];
  error: string | null;
}

/** Everything the synthesis saw, frozen beside its output. */
export interface PlanInputs {
  weekStart: string;
  weekEnd: string;
  activity: ActivitySummary;
  weather: WeatherSummary;
  availability: AvailabilitySummary;
  /** The previously active week, for continuity + the adjustment diff. */
  priorWeek: {
    weekStart: string;
    summary: string;
    sessions: PlannedSession[];
  } | null;
}

export type WeekPlanStatus = 'proposed' | 'active' | 'rejected' | 'superseded' | 'expired';

export interface WeekPlan {
  id: string;
  weekStart: string;
  status: WeekPlanStatus;
  summary: string;
  rationale: string;
  /** What changed vs. the previously active week — what approval is asked FOR. */
  adjustments: string[];
  sessions: PlannedSession[];
  inputs: PlanInputs | Record<string, never>;
  approvalId: string | null;
  approvalKey: string | null;
  model: string | null;
  generatedAt: string;
  resolvedAt: string | null;
}

/** The model's structured answer — the durable fields it is responsible for. */
export interface SynthesizedWeek {
  summary: string;
  rationale: string;
  adjustments: string[];
  sessions: PlannedSession[];
}
