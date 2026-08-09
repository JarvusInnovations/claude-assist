import { describe, expect, it } from 'bun:test';
import { isSecretUrl, redactUrl, redactText, hashPayload } from './redact.js';

const RC_LINK = 'https://claude.ai/code/session_AbC123deadBEEF456';

describe('isSecretUrl', () => {
  it('flags a claude.ai RC takeover link', () => {
    expect(isSecretUrl(RC_LINK)).toBe(true);
  });

  it('flags a generic remote-control / takeover link', () => {
    expect(isSecretUrl('https://sessions.example.com/rc/xyz-token')).toBe(true);
    expect(isSecretUrl('https://host/takeover/abc123')).toBe(true);
  });

  it('does not flag an ordinary URL', () => {
    expect(isSecretUrl('https://team.example.org/projects/42')).toBe(false);
    expect(isSecretUrl('https://example.com/code/sessions')).toBe(false);
  });
});

describe('redactUrl', () => {
  it('strips the secret token from a claude.ai session link but keeps a stable prefix', () => {
    const redacted = redactUrl(RC_LINK);
    expect(redacted).toBe('https://claude.ai/code/session_[redacted]');
    expect(redacted).not.toContain('AbC123deadBEEF456');
  });

  it('redacts a generic RC link to host only', () => {
    expect(redactUrl('https://sessions.example.com/rc/secret-token')).toBe(
      'https://sessions.example.com/[redacted-session-link]'
    );
  });

  it('passes an ordinary URL through unchanged', () => {
    const url = 'https://team.example.org/projects/42';
    expect(redactUrl(url)).toBe(url);
  });
});

describe('redactText', () => {
  it('redacts an RC link embedded inline in a body', () => {
    const body = `Session ready — take over at ${RC_LINK} before it expires.`;
    const redacted = redactText(body);
    expect(redacted).not.toContain('AbC123deadBEEF456');
    expect(redacted).toContain('session_[redacted]');
  });

  it('leaves ordinary text and non-secret URLs alone', () => {
    const body = 'See https://team.example.org/proposals/9 for details.';
    expect(redactText(body)).toBe(body);
  });
});

describe('hashPayload', () => {
  it('is deterministic for equal payloads', () => {
    const a = hashPayload({ priority: 'interrupt', url: RC_LINK });
    const b = hashPayload({ priority: 'interrupt', url: RC_LINK });
    expect(a).toBe(b);
  });

  it('differs when the payload differs', () => {
    const a = hashPayload({ url: RC_LINK });
    const b = hashPayload({ url: `${RC_LINK}X` });
    expect(a).not.toBe(b);
  });

  it('is a 64-char sha256 hex digest', () => {
    expect(hashPayload({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
