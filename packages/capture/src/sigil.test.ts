import { describe, expect, it } from 'bun:test';
import { matchCaptureSigil } from './sigil.js';

describe('matchCaptureSigil', () => {
  it('matches "+ text" and strips the sigil', () => {
    expect(matchCaptureSigil('+ buy milk')).toBe('buy milk');
    expect(matchCaptureSigil('+   extra   spaces')).toBe('extra   spaces');
    expect(matchCaptureSigil('+ https://example.com/article')).toBe(
      'https://example.com/article'
    );
  });

  it('preserves multi-line capture bodies', () => {
    expect(matchCaptureSigil('+ first line\nsecond line')).toBe('first line\nsecond line');
  });

  it('tolerates leading whitespace before the sigil', () => {
    expect(matchCaptureSigil('  + padded')).toBe('padded');
  });

  it('ignores conversational plus usage', () => {
    expect(matchCaptureSigil('+1')).toBeNull();
    expect(matchCaptureSigil('+1 sounds good')).toBeNull();
    expect(matchCaptureSigil('a + b')).toBeNull();
    expect(matchCaptureSigil('what does + mean?')).toBeNull();
    expect(matchCaptureSigil('')).toBeNull();
    expect(matchCaptureSigil('+')).toBeNull();
    expect(matchCaptureSigil('+ ')).toBeNull();
    expect(matchCaptureSigil('normal message')).toBeNull();
  });
});
