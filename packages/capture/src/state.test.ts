import { describe, expect, it } from 'bun:test';
import {
  destinationFor,
  InvalidTransitionError,
  ROUTING_TABLE,
  transition,
} from './state.js';
import { CAPTURE_TYPES, type CaptureStatus } from './types.js';

const ALL_STATUSES: CaptureStatus[] = [
  'queued',
  'classified',
  'awaiting_executor',
  'awaiting_review',
  'routed',
];

describe('routing table', () => {
  it('maps every capture type to a destination', () => {
    for (const type of CAPTURE_TYPES) {
      expect(destinationFor(type)).toBeTruthy();
    }
  });

  it('holds actionable and team_relevant for review — never an auto-write (firewall)', () => {
    expect(ROUTING_TABLE.actionable).toBe('review');
    expect(ROUTING_TABLE.team_relevant).toBe('review');
  });

  it('has no HQ destination anywhere', () => {
    for (const destination of Object.values(ROUTING_TABLE)) {
      expect(destination.toLowerCase()).not.toContain('hq');
    }
  });
});

describe('transition', () => {
  it('classifies only from queued', () => {
    expect(transition('queued', { kind: 'classified', destination: 'tana-inbox' })).toBe(
      'classified'
    );
    for (const status of ALL_STATUSES.filter((s) => s !== 'queued')) {
      expect(() =>
        transition(status, { kind: 'classified', destination: 'tana-inbox' })
      ).toThrow(InvalidTransitionError);
    }
  });

  it('routes to routed from classified and awaiting_executor only', () => {
    expect(transition('classified', { kind: 'route_succeeded' })).toBe('routed');
    expect(transition('awaiting_executor', { kind: 'route_succeeded' })).toBe('routed');
    for (const status of ['queued', 'awaiting_review', 'routed'] as CaptureStatus[]) {
      expect(() => transition(status, { kind: 'route_succeeded' })).toThrow(
        InvalidTransitionError
      );
    }
  });

  it('holds for review from routable states only', () => {
    expect(transition('classified', { kind: 'held' })).toBe('awaiting_review');
    expect(transition('awaiting_executor', { kind: 'held' })).toBe('awaiting_review');
    expect(() => transition('queued', { kind: 'held' })).toThrow(InvalidTransitionError);
    expect(() => transition('routed', { kind: 'held' })).toThrow(InvalidTransitionError);
  });

  it('parks in awaiting_executor when no executor is registered', () => {
    expect(transition('classified', { kind: 'no_executor' })).toBe('awaiting_executor');
    expect(transition('awaiting_executor', { kind: 'no_executor' })).toBe('awaiting_executor');
    expect(() => transition('queued', { kind: 'no_executor' })).toThrow(InvalidTransitionError);
  });

  it('accepts corrections from any post-classification state', () => {
    for (const status of ['classified', 'awaiting_executor', 'awaiting_review', 'routed'] as CaptureStatus[]) {
      expect(transition(status, { kind: 'corrected', destination: 'references' })).toBe(
        'classified'
      );
    }
    expect(() => transition('queued', { kind: 'corrected', destination: 'references' })).toThrow(
      InvalidTransitionError
    );
  });
});
