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
  // As in a real DOM: assigning textContent replaces the element's children.
  // The runtime clears the status panel that way before re-rendering it.
  let text = el.textContent;
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (value: string) => {
      text = value;
      el.children.length = 0;
    },
  });
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
    removeItem: (key: string) => {
      store.delete(key);
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
/** What the fake server answers a POST with; defaults to a plain 201 with no cook mode. */
type PostAnswer = { status: number; body: unknown };

function makeEnv(opts: {
  instance: string;
  localStorage: ReturnType<typeof makeLocalStorage>;
  inputValue?: string;
  lastResponse?: unknown;
  post?: (payload: unknown, attempt: number) => PostAnswer;
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
      const payload = (JSON.parse(init.body ?? '{}') as { payload: unknown }).payload;
      posted.push(payload);
      const answer: PostAnswer = opts.post
        ? opts.post(payload, posted.length)
        : { status: 201, body: { worksheet: { cook_mode: null } } };
      return Promise.resolve({
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: () => Promise.resolve(answer.body),
        text: () => Promise.resolve(JSON.stringify(answer.body)),
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

  /** The status panel's rendered lines (its h2 + p + button text, in order). */
  const statusLines = () => statusEl.children.map((c) => c.textContent);
  /** Click the status panel's action button (Retry / Submit as new), if rendered. */
  const clickStatusButton = () => {
    const button = statusEl.children.find((c) => c.listeners.click?.length);
    if (!button) throw new Error('no action button rendered in the status panel');
    button.click();
  };

  return { window, document, fetchFn, submitEl, restoreEl, inputEl, statusEl, posted, statusLines, clickStatusButton };
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
  // Let the fetch().then(...) chains settle — a failed POST runs through
  // res.text() and a parse before it rejects, which is more ticks than a
  // handful of microtasks, so drain the macrotask queue instead.
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

    // The old draft is simply orphaned, never read again — and the republish's
    // own submission, once confirmed, retires its key rather than filing it
    // under the new instance (see the per-submission key cases below).
    expect(storage.store.has('pages-worksheet:' + SLUG + ':instance-a')).toBe(true);
    expect(storage.store.has('pages-worksheet:' + SLUG + ':instance-b')).toBe(false);
  });
});

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function keyOf(posted: unknown): string {
  return (posted as { submission_key: string }).submission_key;
}

describe('the submission key is minted per submission and retired once the write is confirmed', () => {
  it('a second submit after a success posts a NEW key, and the draft no longer carries the old one', async () => {
    const storage = makeLocalStorage();
    const env = makeEnv({ instance: 'instance-a', localStorage: storage });
    runHelper(env);
    await flush();

    env.submitEl.click();
    await flush();
    // Confirmed: the key is retired with the draft.
    expect(storage.store.has('pages-worksheet:' + SLUG + ':instance-a')).toBe(false);

    // Same page, same instance, the next morning's weights.
    env.inputEl.value = '250';
    env.inputEl.listeners.input![0]!();
    env.submitEl.click();
    await flush();

    expect(env.posted).toHaveLength(2);
    expect(keyOf(env.posted[0])).toMatch(ULID_SHAPE);
    expect(keyOf(env.posted[1])).toMatch(ULID_SHAPE);
    expect(keyOf(env.posted[1])).not.toBe(keyOf(env.posted[0]));
    expect((env.posted[1] as { quantities: { quantity: number }[] }).quantities[0]!.quantity).toBe(250);
  });

  it('a reload of the same instance after a confirmed write starts fresh — no key, no unsent-draft offer', async () => {
    const storage = makeLocalStorage();
    const first = makeEnv({ instance: 'instance-a', localStorage: storage });
    runHelper(first);
    await flush();
    first.submitEl.click();
    await flush();

    // The page comes back tomorrow. Nothing pending is found, so the only
    // restore on offer is the explicit read-back of the last SUBMITTED numbers.
    const reloaded = makeEnv({
      instance: 'instance-a',
      localStorage: storage,
      lastResponse: { payload: { kind: 'worksheet', components: [{ label: 'rice', quantity: 100 }] } },
    });
    runHelper(reloaded);
    await flush();
    expect(reloaded.restoreEl.children[0]!.textContent).toBe('Restore the last submitted entries');

    reloaded.submitEl.click();
    await flush();
    expect(keyOf(reloaded.posted[0])).not.toBe(keyOf(first.posted[0]));
  });

  it('a retry after a FAILED write reuses the pending key — one event, twice attempted', async () => {
    const storage = makeLocalStorage();
    const env = makeEnv({
      instance: 'instance-a',
      localStorage: storage,
      post: (_payload, attempt) =>
        attempt === 1
          ? { status: 502, body: { error: 'journal unreachable' } }
          : { status: 201, body: { worksheet: { cook_mode: null } } },
    });
    runHelper(env);
    await flush();

    env.submitEl.click();
    await flush();
    expect(env.statusLines()[0]).toBe('✗ Not recorded');
    expect(env.statusLines()).toContain('Retry');
    // Still pending, so it survives a reload of this instance.
    expect(JSON.parse(storage.store.get('pages-worksheet:' + SLUG + ':instance-a')!).submission_key).toBe(
      keyOf(env.posted[0])
    );

    env.clickStatusButton();
    await flush();
    expect(env.posted).toHaveLength(2);
    expect(keyOf(env.posted[1])).toBe(keyOf(env.posted[0]));
    expect(env.statusLines()[0]).toBe('✓ Recorded');
  });

  it('a 409 is rendered as its own state, keeps the numbers, and the next tap submits under a NEW key', async () => {
    const storage = makeLocalStorage();
    // A stale draft: yesterday's key, already confirmed server-side, left
    // behind by a runtime that did not yet retire keys.
    const STALE_KEY = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    storage.setItem(
      'pages-worksheet:' + SLUG + ':instance-a',
      JSON.stringify({ submission_key: STALE_KEY, quantities: [{ label: 'rice', quantity: 169 }] })
    );
    const env = makeEnv({
      instance: 'instance-a',
      localStorage: storage,
      inputValue: '169',
      post: (payload) =>
        keyOf(payload) === STALE_KEY
          ? {
              status: 409,
              body: {
                error: `submission_key ${STALE_KEY} already recorded a different submission on this page`,
              },
            }
          : { status: 201, body: { worksheet: { cook_mode: null } } },
    });
    runHelper(env);
    await flush();

    env.submitEl.click();
    await flush();

    expect(keyOf(env.posted[0])).toBe(STALE_KEY);
    const lines = env.statusLines();
    expect(lines[0]).toBe('✗ Not recorded');
    expect(lines[1]).toMatch(/HTTP 409/);
    expect(lines[1]).toMatch(/already recorded a different submission/);
    expect(lines).toContain('Submit as new');
    // The numbers stay; the stale key does not.
    expect(env.inputEl.value).toBe('169');
    const draft = JSON.parse(storage.store.get('pages-worksheet:' + SLUG + ':instance-a')!);
    expect(draft.submission_key).toBeUndefined();
    expect(draft.quantities).toEqual([{ label: 'rice', quantity: 169 }]);

    env.clickStatusButton();
    await flush();
    expect(env.posted).toHaveLength(2);
    expect(keyOf(env.posted[1])).toMatch(ULID_SHAPE);
    expect(keyOf(env.posted[1])).not.toBe(STALE_KEY);
    expect(env.statusLines()[0]).toBe('✓ Recorded');
  });
});

describe('the confirmation lists what was written and what did (not) move', () => {
  it('renders the entry with its totals, each applied decrement, and each refused one with its reason', async () => {
    const env = makeEnv({
      instance: 'instance-a',
      localStorage: makeLocalStorage(),
      post: () => ({
        status: 201,
        body: {
          worksheet: {
            totals: { calories: 130 },
            cook_mode: {
              disposition: 'eaten',
              label: 'rice bowl',
              status: 'logged',
              kind: 'entry',
              ulid: '01JAAAAAAAAAAAAAAAAAAAAAAA',
              created: true,
              decrements: {
                applied: [{ component: 'rice', item_ulid: '01JRRRRRRRRRRRRRRRRRRRRRRR', quantity: 100, unit: 'g' }],
                unapplied: [
                  { component: 'oil', item_ulid: '01JOOOOOOOOOOOOOOOOOOOOOOO', quantity: 10, reason: 'product has no net_content_g' },
                ],
              },
              error: null,
            },
          },
        },
      }),
    });
    runHelper(env);
    await flush();

    env.submitEl.click();
    await flush();

    const lines = env.statusLines();
    expect(lines[0]).toBe('✓ Recorded');
    expect(lines[1]).toBe('Logged "rice bowl" to the journal — Calories 130 (entry 01JAAAAAAAAAAAAAAAAAAAAAAA).');
    expect(lines[2]).toBe('− 100 g rice (item 01JRRRRRRRRRRRRRRRRRRRRRRR)');
    expect(lines[3]).toBe('⚠ oil NOT decremented (10) (item 01JOOOOOOOOOOOOOOOOOOOOOOO): product has no net_content_g');
  });

  it('says plainly when a write moved no stock at all', async () => {
    const env = makeEnv({
      instance: 'instance-a',
      localStorage: makeLocalStorage(),
      post: () => ({
        status: 201,
        body: {
          worksheet: {
            totals: { calories: 130 },
            cook_mode: {
              disposition: 'eaten',
              label: 'rice bowl',
              status: 'logged',
              kind: 'entry',
              ulid: '01JAAAAAAAAAAAAAAAAAAAAAAA',
              created: true,
              decrements: { applied: [], unapplied: [] },
              error: null,
            },
          },
        },
      }),
    });
    runHelper(env);
    await flush();
    env.submitEl.click();
    await flush();
    expect(env.statusLines()[2]).toMatch(/No stock was decremented/);
  });

  it('a replay shows the original decrements under "already recorded"', async () => {
    const env = makeEnv({
      instance: 'instance-a',
      localStorage: makeLocalStorage(),
      post: () => ({
        status: 201,
        body: {
          worksheet: {
            totals: { calories: 130 },
            cook_mode: {
              disposition: 'eaten',
              label: 'rice bowl',
              status: 'already-logged',
              kind: 'entry',
              ulid: '01JAAAAAAAAAAAAAAAAAAAAAAA',
              created: false,
              decrements: {
                applied: [{ component: 'rice', item_ulid: '01JRRRRRRRRRRRRRRRRRRRRRRR', quantity: 100, unit: 'g' }],
                unapplied: [],
              },
              error: null,
            },
          },
        },
      }),
    });
    runHelper(env);
    await flush();
    env.submitEl.click();
    await flush();
    const lines = env.statusLines();
    expect(lines[1]).toMatch(/^Already recorded earlier — nothing was written twice/);
    expect(lines[2]).toBe('− 100 g rice (item 01JRRRRRRRRRRRRRRRRRRRRRRR)');
  });
});
