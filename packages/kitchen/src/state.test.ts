import { describe, expect, it } from 'bun:test';
import { InvalidTransitionError, transition } from './state.js';

describe('kitchen entry transitions', () => {
  it('estimating -> estimated on a successful estimate', () => {
    expect(transition('estimating', { kind: 'estimated' })).toBe('estimated');
  });

  it('rejects estimated event from a non-estimating status', () => {
    expect(() => transition('estimated', { kind: 'estimated' })).toThrow(InvalidTransitionError);
    expect(() => transition('failed', { kind: 'estimated' })).toThrow(InvalidTransitionError);
  });

  it('estimating -> failed once attempts are capped', () => {
    expect(transition('estimating', { kind: 'estimate_capped' })).toBe('failed');
  });

  it('rejects estimate_capped from a non-estimating status', () => {
    expect(() => transition('estimated', { kind: 'estimate_capped' })).toThrow(InvalidTransitionError);
  });

  it('manual_override always lands on estimated, from any status', () => {
    expect(transition('estimating', { kind: 'manual_override' })).toBe('estimated');
    expect(transition('estimated', { kind: 'manual_override' })).toBe('estimated');
    expect(transition('failed', { kind: 'manual_override' })).toBe('estimated');
  });

  it('re_queue moves estimated/failed/estimating back to estimating', () => {
    expect(transition('estimated', { kind: 're_queue' })).toBe('estimating');
    expect(transition('failed', { kind: 're_queue' })).toBe('estimating');
    expect(transition('estimating', { kind: 're_queue' })).toBe('estimating');
  });
});
