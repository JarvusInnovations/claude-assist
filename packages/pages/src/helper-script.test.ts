/**
 * Exercises the ACTUAL browser runtime embedded in `HELPER_SCRIPT` — not a
 * reimplementation of its logic — against a minimal fake DOM/localStorage/
 * fetch, so this pins real behavior rather than a paraphrase of it.
 *
 * Regression coverage for the bug fixed here: the worksheet draft (submission
 * key + last-entered quantities, persisted so a page reloaded after the
 * network dropped retries the SAME submission) was keyed on slug alone, so it
 * also survived a REPUBLISH. A republished sheet came up pre-filled with the
 * previous run's numbers and previous idempotency key, so the next submit was
 * treated as a replay: it wrote nothing and still showed "✓ Recorded". The
 * fix scopes the draft to (slug, instance), where `instance` is the fresh
 * token `renderWorksheetHtml` mints on every render (see worksheet.ts).
 */

import { describe, expect, it } from 'bun:test';
import { HELPER_SCRIPT } from './helper-script.js';

const SLUG = 'grain-bowl-prep';

interface FakeElement {
  attributes: Record<string, string>;
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  children: FakeElement[];
  listeners: Record<string, Array<() => void>>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, handler: () => void): void;
  appendChild(child: FakeElement): void;
  click(): void;
}

function makeElement(overrides: Partial<FakeElement> = {}): FakeElement {
  const el: FakeElement = {
    attributes: {},
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    children: [],
    listeners: {},
    getAttribute(name) {
      return el.attributes[name] ?? null;
    },
    setAttribute(name, value) {
      el.attributes[name] = value;
    },
    addEventListener(type, handler) {
      (el.listeners[type] ??= []).push(handler);
    },
    appendChild(child) {
      el.children.push(child);
    },
    click() {
      (el.listeners.click ?? []).forEach((h) => h());
    },
    ...overrides,
  };
  return el;
}

function makeLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

/** A worksheet definition JSON as `renderWorksheetHtml` would embed it. */
function definitionJson() {
  return JSON.stringify({
    kind: 'worksheet',
    version: 1,
    basis: 100,
    unit: 'g',
    fields: [{ key: 'calories', label: 'Calories', precision: 0 }],
    components: [{ label: 'rice', quantity: 100, per_basis: { calories: 130 } }],
  });
}

/** Builds the fake `window` + `document` + `fetch` a rendered page presents. */
function makeEnv(opts: {
  instance: string;
  localStorage: ReturnType<typeof makeLocalStorage>;
  inputValue?: string;
  lastResponse?: unknown;
}) {
  const definitionEl = makeElement({
    textContent: definitionJson(),
    attributes: { 'data-pw-instance': opts.instance },
  });
  const inputEl = makeElement({
    value: opts.inputValue ?? '100',
    attributes: { 'data-pw-label': 'rice' },
  });
  const statusEl = makeElement();
  const submitEl = makeElement();
  const noteEl = makeElement();
  const restoreEl = makeElement({ hidden: true });

  const byId: Record<string, FakeElement> = {
    'pw-definition': definitionEl,
    'pw-status': statusEl,
    'pw-submit': submitEl,
    'pw-note': noteEl,
    'pw-restore': restoreEl,
  };

  const posted: unknown[] = [];

  const document = {
    getElementById: (id: string) => byId[id] ?? null,
    querySelectorAll: (sel: string) => (sel === '[data-pw-label]' ? [inputEl] : []),
    querySelector: () => null,
    createElement: () => makeElement(),
  };

  const window = {
    location: { pathname: '/pages/' + SLUG },
    crypto: globalThis.crypto,
    localStorage: opts.localStorage,
  };

  const fetchFn = (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      // pagesRespond wraps the caller's payload as `{ payload, anchor, note }`.
      posted.push((JSON.parse(init.body ?? '{}') as { payload: unknown }).payload);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ worksheet: { cook_mode: null } }),
      });
    }
    // GET .../responses?latest=1 — the server-side "last submitted" read-back.
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          responses: opts.lastResponse ? [opts.lastResponse] : [],
        }),
    });
  };

  return { window, document, fetchFn, submitEl, restoreEl, inputEl, posted };
}

function runHelper(env: ReturnType<typeof makeEnv>) {
  // The IIFE assigns window.pagesWorksheetInit etc as a side effect of being
  // invoked — the exact mechanism a `<script src="/pages/_helper.js">` tag
  // triggers in a real page.
  const install = new Function('window', 'document', 'fetch', HELPER_SCRIPT);
  install(env.window, env.document, env.fetchFn);
  (env.window as unknown as { pagesWorksheetInit: () => void }).pagesWorksheetInit();
}

async function flush() {
  // Let the pagesLastResponse().then(...) microtask chain settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('worksheet draft: keyed on (slug, instance)', () => {
  it('a reload of the SAME instance restores the unsent draft and reuses its submission_key', async () => {
    const storage = makeLocalStorage();
    const OLD_KEY = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    storage.setItem(
      'pages-worksheet:' + SLUG + ':instance-a',
      JSON.stringify({ submission_key: OLD_KEY, quantities: [{ label: 'rice', quantity: 250 }] })
    );

    const env = makeEnv({ instance: 'instance-a', localStorage: storage });
    runHelper(env);
    await flush();

    // The unsent-draft restore offer fires (same guarantee the design exists
    // for: a page reloaded after the network dropped can retry).
    expect(env.restoreEl.hidden).toBe(false);

    env.submitEl.click();
    await flush();

    expect(env.posted).toHaveLength(1);
    expect((env.posted[0] as { submission_key: string }).submission_key).toBe(OLD_KEY);
  });

  it('a republished slug (new instance) does NOT restore the prior quantities and does NOT reuse the prior submission_key', async () => {
    const storage = makeLocalStorage();
    const OLD_KEY = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    // Simulates a draft left behind by the PRIOR published instance — e.g. an
    // in-flight retry, or simply the last thing typed before the sheet was
    // corrected and republished.
    storage.setItem(
      'pages-worksheet:' + SLUG + ':instance-a',
      JSON.stringify({ submission_key: OLD_KEY, quantities: [{ label: 'rice', quantity: 250 }] })
    );

    // The republished page renders with a NEW instance token and fresh
    // (published-default) input values — nothing pre-filled from the old run.
    const env = makeEnv({ instance: 'instance-b', localStorage: storage, inputValue: '100' });
    runHelper(env);
    await flush();

    // No stale unsent-draft offer, and (with no server-side prior response
    // mocked) no restore offer at all — the inputs stay at their fresh
    // published defaults instead of silently resurrecting 250.
    expect(env.restoreEl.hidden).toBe(true);
    expect(env.inputEl.value).toBe('100');

    env.submitEl.click();
    await flush();

    expect(env.posted).toHaveLength(1);
    const submitted = env.posted[0] as { submission_key: string; quantities: { quantity: number }[] };
    expect(submitted.submission_key).not.toBe(OLD_KEY);
    expect(submitted.quantities[0]!.quantity).toBe(100);

    // The republish's own draft is filed under its OWN instance, not the old
    // one — the old draft is simply orphaned, never read again.
    expect(storage.store.has('pages-worksheet:' + SLUG + ':instance-b')).toBe(true);
    const freshDraft = JSON.parse(storage.store.get('pages-worksheet:' + SLUG + ':instance-b')!);
    expect(freshDraft.submission_key).toBe(submitted.submission_key);
  });
});
