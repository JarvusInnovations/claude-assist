import { describe, expect, it } from 'bun:test';
import {
  classifyDeterministic,
  isQuietHour,
  isQuietHours,
  localHourInTz,
  summarize,
  type DeterministicInput,
} from './urgency.js';
import type { SlackCandidate } from './types.js';

function candidate(text: string, over: Partial<SlackCandidate> = {}): SlackCandidate {
  return {
    channel: 'C1',
    ts: '1720620000.000100',
    threadTs: null,
    channelType: 'im',
    sender: 'U_TEAMMATE',
    senderName: 'Julia',
    text,
    isBot: false,
    ...over,
  };
}

function input(text: string, over: Partial<DeterministicInput> = {}): DeterministicInput {
  return {
    candidate: candidate(text),
    isDirectMessage: true,
    mentionsOwner: false,
    senderIsTeam: true,
    weight: 0,
    ...over,
  };
}

describe('classifyDeterministic — earned interrupts', () => {
  it('teammate DM with a question → urgent', () => {
    expect(classifyDeterministic(input('can you review the SEPTA scope today?')).tier).toBe('urgent');
  });

  it('teammate DM signaling blockage → urgent', () => {
    const r = classifyDeterministic(input("I'm blocked and waiting on you for the contract sign-off"));
    expect(r.tier).toBe('urgent');
    expect(r.signals).toContain('blockage');
  });

  it('teammate DM with a deadline → urgent', () => {
    expect(classifyDeterministic(input('need the numbers by EOD')).tier).toBe('urgent');
  });

  it('teammate @mention in a channel with a direct ask → urgent', () => {
    const r = classifyDeterministic(
      input('<@UOWNER> can you approve this before the call?', {
        candidate: candidate('<@UOWNER> can you approve this before the call?', { channelType: 'channel' }),
        isDirectMessage: false,
        mentionsOwner: true,
      })
    );
    expect(r.tier).toBe('urgent');
  });

  it('explicit emergency from a teammate → emergency tier', () => {
    const r = classifyDeterministic(input('URGENT: prod is down, need you now'));
    expect(r.tier).toBe('emergency');
    expect(r.signals).toContain('emergency');
  });
});

describe('classifyDeterministic — the model residue (ambiguous middle)', () => {
  it('directed teammate DM with no explicit signal → residue', () => {
    expect(classifyDeterministic(input('following up on the thing from earlier')).tier).toBe('residue');
  });

  it('@mention with a concrete ask from a NON-teammate → residue (a model look)', () => {
    const r = classifyDeterministic(
      input('<@UOWNER> are you able to join?', {
        candidate: candidate('<@UOWNER> are you able to join?', { channelType: 'channel', sender: 'U_STRANGER' }),
        isDirectMessage: false,
        mentionsOwner: true,
        senderIsTeam: false,
      })
    );
    expect(r.tier).toBe('residue');
  });
});

describe('classifyDeterministic — negatives (never interrupt)', () => {
  it('channel chatter that does not mention the owner → drop', () => {
    const r = classifyDeterministic(
      input('lunch anyone?', {
        candidate: candidate('lunch anyone?', { channelType: 'channel' }),
        isDirectMessage: false,
        mentionsOwner: false,
      })
    );
    expect(r.tier).toBe('drop');
  });

  it('cold DM from a non-teammate with no ask → drop', () => {
    const r = classifyDeterministic(
      input('hi, loved your talk', { senderIsTeam: false })
    );
    expect(r.tier).toBe('drop');
  });
});

describe('classifyDeterministic — correction weights', () => {
  it('a strong positive weight promotes residue → urgent', () => {
    expect(classifyDeterministic(input('quick note for you', { weight: 1.5 })).tier).toBe('urgent');
  });

  it('a strong negative weight demotes an ask → residue (false-positive sender)', () => {
    // hasAsk would be urgent, but corrections taught us this sender over-fires.
    expect(
      classifyDeterministic(input('can you look at this?', { weight: -1.5 })).tier
    ).toBe('residue');
  });

  it('a negative weight never suppresses an explicit emergency', () => {
    expect(classifyDeterministic(input('emergency, site is down', { weight: -5 })).tier).toBe(
      'emergency'
    );
  });
});

describe('summarize', () => {
  it('strips mention/link tokens and clips', () => {
    expect(summarize('<@UOWNER> please see <https://x.com|the doc>')).toBe('please see the doc');
  });
});

describe('isQuietHour — boundaries (half-open, wrapping window 22→7)', () => {
  it('21:xx is not quiet', () => expect(isQuietHour(21, 22, 7)).toBe(false));
  it('22:00 is quiet (start inclusive)', () => expect(isQuietHour(22, 22, 7)).toBe(true));
  it('02:00 is quiet', () => expect(isQuietHour(2, 22, 7)).toBe(true));
  it('06:xx is quiet', () => expect(isQuietHour(6, 22, 7)).toBe(true));
  it('07:00 is NOT quiet (end exclusive)', () => expect(isQuietHour(7, 22, 7)).toBe(false));
  it('noon is not quiet', () => expect(isQuietHour(12, 22, 7)).toBe(false));
  it('an empty window is never quiet', () => expect(isQuietHour(3, 7, 7)).toBe(false));
});

describe('localHourInTz + isQuietHours', () => {
  it('resolves the wall-clock hour in America/New_York', () => {
    // 2026-07-10T05:00:00Z = 01:00 EDT
    expect(localHourInTz(new Date('2026-07-10T05:00:00Z'), 'America/New_York')).toBe(1);
    // 2026-07-10T12:00:00Z = 08:00 EDT
    expect(localHourInTz(new Date('2026-07-10T12:00:00Z'), 'America/New_York')).toBe(8);
  });

  it('01:00 ET is quiet, 08:00 ET is not', () => {
    const cfg = { timeZone: 'America/New_York', startHour: 22, endHour: 7 };
    expect(isQuietHours(new Date('2026-07-10T05:00:00Z'), cfg)).toBe(true);
    expect(isQuietHours(new Date('2026-07-10T12:00:00Z'), cfg)).toBe(false);
  });
});
