import { describe, expect, it } from 'bun:test';
import { collectUrls, deterministicClassification } from './classifier.js';

describe('deterministicClassification', () => {
  it('classifies a URL-only capture as link_reference with no model call', () => {
    const result = deterministicClassification({
      text: 'https://example.com/great-article',
      urls: [],
    });
    expect(result).toMatchObject({
      type: 'link_reference',
      confidence: 1,
      classifier: 'deterministic',
    });
  });

  it('handles multiple bare URLs and surrounding whitespace', () => {
    const result = deterministicClassification({
      text: '  https://a.com/x \n https://b.com/y  ',
      urls: [],
    });
    expect(result?.type).toBe('link_reference');
  });

  it('classifies urls[]-only captures (text mirrors the url)', () => {
    const result = deterministicClassification({
      text: 'https://example.com/shared',
      urls: ['https://example.com/shared'],
    });
    expect(result?.type).toBe('link_reference');
  });

  it('defers to the model when there is commentary', () => {
    expect(
      deterministicClassification({
        text: 'read this later, looks important https://example.com',
        urls: [],
      })
    ).toBeNull();
  });

  it('defers to the model for plain thoughts', () => {
    expect(deterministicClassification({ text: 'call mom about the trip', urls: [] })).toBeNull();
  });
});

describe('collectUrls', () => {
  it('merges explicit urls[] with URLs found in text, deduped', () => {
    expect(
      collectUrls({
        text: 'see https://a.com and https://b.com',
        urls: ['https://a.com', 'https://c.com'],
      })
    ).toEqual(['https://a.com', 'https://c.com', 'https://b.com']);
  });
});
