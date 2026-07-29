/**
 * The **worksheet** response pattern — a typed request/response contract for
 * "here are weighable components with their per-basis references; the human
 * states the actual quantities; the result is a computed panel plus a record of
 * what it accounted for."
 *
 * Before this existed, every such page was hand-rolled: the author embedded a
 * component table, restated each per-basis constant, recomputed the panel in
 * bespoke client-side JS, and posted a free-form payload whose shape was
 * convention rather than contract — so each sheet reimplemented the same
 * arithmetic and a later consumer had to guess at the result. Here the
 * definition is data, the totals are computed from that data (server-side, by
 * ONE implementation), and the stored payload has a declared shape.
 *
 * The pattern is deliberately domain-agnostic: `fields` are arbitrary named
 * numeric quantities and `per_basis` is a plain reference table, so nothing in
 * this file knows what a calorie is. The domain lives in the optional
 * `cook_mode` directive's consumer (see PagesPluginConfig.worksheetCookSink and
 * specs/modules/pages.md § Cook mode), which is injected — never imported.
 *
 * This is one typed pattern, not a form builder: exactly one shape (weighable
 * components → computed totals), one renderer, one submit. A page that needs
 * something else publishes its own HTML, as before.
 */

export const WORKSHEET_KIND = 'worksheet';
export const WORKSHEET_VERSION = 1;

/** Field/component keys are identifier-ish so they are safe as JSON + DOM ids. */
export const WORKSHEET_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A submission key is a ULID (Crockford base32, 26 chars) — the SAME shape the
 * kitchen module's client-generated entry/item ULIDs use, because that is
 * exactly what it becomes when a worksheet runs in cook mode
 * (specs/modules/pages.md § Idempotency). One key, one meaning.
 */
export const WORKSHEET_KEY_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Sanity bounds — a fat-fingered quantity should 400, not compute nonsense. */
export const WORKSHEET_MAX_QUANTITY = 100_000;
export const WORKSHEET_MAX_COMPONENTS = 60;
export const WORKSHEET_MAX_FIELDS = 24;

/**
 * What a submitted worksheet DOES, if anything, beyond landing in the response
 * queue. `eaten` and `packed` are not two flavors of one write — they are
 * different acts with different ledger consequences (see specs/modules/pages.md
 * § Cook mode).
 */
export type WorksheetDisposition = 'eaten' | 'packed';

export const WORKSHEET_DISPOSITIONS: readonly WorksheetDisposition[] = ['eaten', 'packed'];

/** One computed output column: a named total, its label, unit, and rounding. */
export interface WorksheetField {
  key: string;
  label: string;
  unit?: string;
  /** Decimal places for display + the stored total. 0..3, default 1. */
  precision?: number;
}

/** One weighable row: a planned quantity plus its per-`basis` reference values. */
export interface WorksheetComponent {
  label: string;
  /** The planned/default quantity, pre-filled in the input. */
  quantity: number;
  /** field key → value per `basis` units of this component. */
  per_basis: Record<string, number>;
  note?: string;
  /** False pins the row (rendered read-only). Default true. */
  editable?: boolean;
}

/**
 * The cook-mode directive: what submitting this worksheet writes. Declared at
 * PUBLISH time, not chosen at submit time — one submit, one consequence, so the
 * confirmation can state exactly what happened.
 */
export interface WorksheetCookDirective {
  disposition: WorksheetDisposition;
  /** Names the resulting entry (eaten) or derived item (packed). */
  label: string;
  /** `packed` only: how many portions the batch yields (counted item). */
  units?: number;
  /** `packed` only: shelf-life class for the derived item. */
  shelf_life_class?: string;
  /** `packed` only: macro provenance for the derived item's later one-tap log. */
  recipe_ulid?: string;
  /** `packed` only: tracked stock this batch is made from (decremented). */
  sources?: { item_ulid: string; amount?: number }[];
}

export interface WorksheetDefinition {
  kind: typeof WORKSHEET_KIND;
  version: typeof WORKSHEET_VERSION;
  heading?: string;
  intro?: string;
  /** Quantity units that `per_basis` values are stated per. Default 100. */
  basis?: number;
  /** Display unit for quantities (e.g. `g`). Default `g`. */
  unit?: string;
  fields: WorksheetField[];
  components: WorksheetComponent[];
  /** Free-text instructions rendered under the table (where °F etc. live). */
  steps?: string[];
  submit_label?: string;
  note_label?: string;
  cook_mode?: WorksheetCookDirective;
}

/** What the page's client script POSTs as the response `payload`. */
export interface WorksheetSubmission {
  kind: typeof WORKSHEET_KIND;
  version: typeof WORKSHEET_VERSION;
  /** Client-generated ULID, stable across retries — the idempotency key. */
  submission_key: string;
  /** Stated quantities; an omitted component keeps its planned quantity. */
  quantities: { label: string; quantity: number }[];
  note?: string;
}

/** field key → total, null when NO component carried that field. */
export type WorksheetTotals = Record<string, number | null>;

/**
 * The normalized payload stored on the response row: the submitted quantities,
 * the per-basis references they were computed against, and the server-computed
 * totals. A consumer reads `totals` and is done — no recomputation, no guessing.
 */
export interface WorksheetResponsePayload {
  kind: typeof WORKSHEET_KIND;
  version: typeof WORKSHEET_VERSION;
  submission_key: string;
  basis: number;
  unit: string;
  components: {
    label: string;
    quantity: number;
    per_basis: Record<string, number>;
  }[];
  totals: WorksheetTotals;
  note: string | null;
  /** Present only on a cook-mode worksheet; `ulid` === `submission_key`. */
  cook_mode?: {
    disposition: WorksheetDisposition;
    label: string;
    ulid: string;
  };
}

export class WorksheetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorksheetValidationError';
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorksheetValidationError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new WorksheetValidationError(`${what} has unknown ${unknown.length > 1 ? 'keys' : 'key'}: ${unknown.join(', ')}`);
  }
}

function requireFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorksheetValidationError(`${what} must be a finite number`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, what: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorksheetValidationError(`${what} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new WorksheetValidationError(`${what} must be at most ${maxLength} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, what: string, maxLength = 4_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new WorksheetValidationError(`${what} must be a string`);
  if (value.length > maxLength) {
    throw new WorksheetValidationError(`${what} must be at most ${maxLength} characters`);
  }
  return value;
}

function validateCookDirective(raw: unknown): WorksheetCookDirective {
  const obj = asRecord(raw, 'cook_mode');
  rejectUnknownKeys(
    obj,
    ['disposition', 'label', 'units', 'shelf_life_class', 'recipe_ulid', 'sources'],
    'cook_mode'
  );

  const disposition = obj.disposition;
  if (typeof disposition !== 'string' || !WORKSHEET_DISPOSITIONS.includes(disposition as WorksheetDisposition)) {
    throw new WorksheetValidationError(
      `cook_mode.disposition must be one of: ${WORKSHEET_DISPOSITIONS.join(', ')}`
    );
  }
  const directive: WorksheetCookDirective = {
    disposition: disposition as WorksheetDisposition,
    label: requireNonEmptyString(obj.label, 'cook_mode.label', 200),
  };

  // The `packed` extras describe an inventory conversion. Rejecting them on an
  // `eaten` sheet is the point: an eaten meal has no derived item to give a
  // shelf life or a unit count to, so accepting them would silently drop them.
  const packedOnly = ['units', 'shelf_life_class', 'recipe_ulid', 'sources'].filter(
    (k) => obj[k] !== undefined
  );
  if (directive.disposition === 'eaten' && packedOnly.length > 0) {
    throw new WorksheetValidationError(
      `cook_mode.${packedOnly[0]} applies only to disposition 'packed'`
    );
  }

  if (obj.units !== undefined) {
    const units = requireFiniteNumber(obj.units, 'cook_mode.units');
    if (!Number.isInteger(units) || units < 1 || units > 1_000) {
      throw new WorksheetValidationError('cook_mode.units must be an integer between 1 and 1000');
    }
    directive.units = units;
  }
  if (obj.shelf_life_class !== undefined) {
    directive.shelf_life_class = requireNonEmptyString(
      obj.shelf_life_class,
      'cook_mode.shelf_life_class',
      50
    );
  }
  if (obj.recipe_ulid !== undefined) {
    directive.recipe_ulid = requireNonEmptyString(obj.recipe_ulid, 'cook_mode.recipe_ulid', 26);
  }
  if (obj.sources !== undefined) {
    if (!Array.isArray(obj.sources)) {
      throw new WorksheetValidationError('cook_mode.sources must be an array');
    }
    directive.sources = obj.sources.map((raw, i) => {
      const src = asRecord(raw, `cook_mode.sources[${i}]`);
      rejectUnknownKeys(src, ['item_ulid', 'amount'], `cook_mode.sources[${i}]`);
      const entry: { item_ulid: string; amount?: number } = {
        item_ulid: requireNonEmptyString(src.item_ulid, `cook_mode.sources[${i}].item_ulid`, 26),
      };
      if (src.amount !== undefined) {
        entry.amount = requireFiniteNumber(src.amount, `cook_mode.sources[${i}].amount`);
      }
      return entry;
    });
  }
  return directive;
}

/**
 * Validate + normalize a published worksheet definition. Throws
 * `WorksheetValidationError` (→ 400) with a message naming the offending path;
 * returns a definition with every default filled in, so nothing downstream has
 * to re-apply them.
 */
export function validateWorksheetDefinition(raw: unknown): WorksheetDefinition {
  const obj = asRecord(raw, 'worksheet');
  rejectUnknownKeys(
    obj,
    [
      'kind',
      'version',
      'heading',
      'intro',
      'basis',
      'unit',
      'fields',
      'components',
      'steps',
      'submit_label',
      'note_label',
      'cook_mode',
    ],
    'worksheet'
  );

  if (obj.kind !== WORKSHEET_KIND) {
    throw new WorksheetValidationError(`worksheet.kind must be '${WORKSHEET_KIND}'`);
  }
  if (obj.version !== WORKSHEET_VERSION) {
    throw new WorksheetValidationError(`worksheet.version must be ${WORKSHEET_VERSION}`);
  }

  const basis = obj.basis === undefined ? 100 : requireFiniteNumber(obj.basis, 'worksheet.basis');
  if (basis <= 0) throw new WorksheetValidationError('worksheet.basis must be > 0');

  if (!Array.isArray(obj.fields) || obj.fields.length === 0) {
    throw new WorksheetValidationError('worksheet.fields must be a non-empty array');
  }
  if (obj.fields.length > WORKSHEET_MAX_FIELDS) {
    throw new WorksheetValidationError(`worksheet.fields must have at most ${WORKSHEET_MAX_FIELDS} entries`);
  }
  const fields: WorksheetField[] = obj.fields.map((rawField, i) => {
    const f = asRecord(rawField, `worksheet.fields[${i}]`);
    rejectUnknownKeys(f, ['key', 'label', 'unit', 'precision'], `worksheet.fields[${i}]`);
    const key = requireNonEmptyString(f.key, `worksheet.fields[${i}].key`, 64);
    if (!WORKSHEET_FIELD_KEY_PATTERN.test(key)) {
      throw new WorksheetValidationError(
        `worksheet.fields[${i}].key must match ${WORKSHEET_FIELD_KEY_PATTERN.source}`
      );
    }
    const field: WorksheetField = {
      key,
      label: requireNonEmptyString(f.label, `worksheet.fields[${i}].label`, 120),
      precision: 1,
    };
    const unit = optionalString(f.unit, `worksheet.fields[${i}].unit`, 20);
    if (unit !== undefined) field.unit = unit;
    if (f.precision !== undefined) {
      const p = requireFiniteNumber(f.precision, `worksheet.fields[${i}].precision`);
      if (!Number.isInteger(p) || p < 0 || p > 3) {
        throw new WorksheetValidationError(
          `worksheet.fields[${i}].precision must be an integer 0..3`
        );
      }
      field.precision = p;
    }
    return field;
  });

  const fieldKeys = new Set(fields.map((f) => f.key));
  if (fieldKeys.size !== fields.length) {
    throw new WorksheetValidationError('worksheet.fields keys must be unique');
  }

  if (!Array.isArray(obj.components) || obj.components.length === 0) {
    throw new WorksheetValidationError('worksheet.components must be a non-empty array');
  }
  if (obj.components.length > WORKSHEET_MAX_COMPONENTS) {
    throw new WorksheetValidationError(
      `worksheet.components must have at most ${WORKSHEET_MAX_COMPONENTS} entries`
    );
  }
  const components: WorksheetComponent[] = obj.components.map((rawComponent, i) => {
    const c = asRecord(rawComponent, `worksheet.components[${i}]`);
    rejectUnknownKeys(c, ['label', 'quantity', 'per_basis', 'note', 'editable'], `worksheet.components[${i}]`);
    const quantity = requireFiniteNumber(c.quantity, `worksheet.components[${i}].quantity`);
    if (quantity < 0 || quantity > WORKSHEET_MAX_QUANTITY) {
      throw new WorksheetValidationError(
        `worksheet.components[${i}].quantity must be between 0 and ${WORKSHEET_MAX_QUANTITY}`
      );
    }
    const perBasisRaw = asRecord(c.per_basis, `worksheet.components[${i}].per_basis`);
    const per_basis: Record<string, number> = {};
    for (const [key, value] of Object.entries(perBasisRaw)) {
      if (!fieldKeys.has(key)) {
        throw new WorksheetValidationError(
          `worksheet.components[${i}].per_basis.${key} is not a declared field key`
        );
      }
      per_basis[key] = requireFiniteNumber(value, `worksheet.components[${i}].per_basis.${key}`);
    }
    const component: WorksheetComponent = {
      label: requireNonEmptyString(c.label, `worksheet.components[${i}].label`, 200),
      quantity,
      per_basis,
    };
    const note = optionalString(c.note, `worksheet.components[${i}].note`, 500);
    if (note !== undefined) component.note = note;
    if (c.editable !== undefined) {
      if (typeof c.editable !== 'boolean') {
        throw new WorksheetValidationError(`worksheet.components[${i}].editable must be a boolean`);
      }
      component.editable = c.editable;
    }
    return component;
  });

  const labels = new Set(components.map((c) => c.label));
  if (labels.size !== components.length) {
    // The label IS the join key between a submission and the definition, so a
    // duplicate would make a stated quantity ambiguous rather than merely ugly.
    throw new WorksheetValidationError('worksheet.components labels must be unique');
  }

  const definition: WorksheetDefinition = {
    kind: WORKSHEET_KIND,
    version: WORKSHEET_VERSION,
    basis,
    unit: optionalString(obj.unit, 'worksheet.unit', 20) ?? 'g',
    fields,
    components,
  };

  const heading = optionalString(obj.heading, 'worksheet.heading', 300);
  if (heading !== undefined) definition.heading = heading;
  const intro = optionalString(obj.intro, 'worksheet.intro');
  if (intro !== undefined) definition.intro = intro;
  if (obj.steps !== undefined) {
    if (!Array.isArray(obj.steps)) throw new WorksheetValidationError('worksheet.steps must be an array');
    definition.steps = obj.steps.map((s, i) => requireNonEmptyString(s, `worksheet.steps[${i}]`, 2_000));
  }
  const submitLabel = optionalString(obj.submit_label, 'worksheet.submit_label', 80);
  if (submitLabel !== undefined) definition.submit_label = submitLabel;
  const noteLabel = optionalString(obj.note_label, 'worksheet.note_label', 120);
  if (noteLabel !== undefined) definition.note_label = noteLabel;
  if (obj.cook_mode !== undefined) definition.cook_mode = validateCookDirective(obj.cook_mode);

  return definition;
}

/** True when a response payload claims to be a worksheet submission. */
export function isWorksheetPayload(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).kind === WORKSHEET_KIND
  );
}

/**
 * Validate a submitted payload AGAINST the worksheet definition currently
 * published for the slug. Everything a consumer will read is checked here, so
 * `computeWorksheetTotals` can be pure arithmetic over trusted numbers.
 */
export function validateWorksheetSubmission(
  raw: unknown,
  definition: WorksheetDefinition
): WorksheetSubmission {
  const obj = asRecord(raw, 'payload');
  rejectUnknownKeys(obj, ['kind', 'version', 'submission_key', 'quantities', 'note'], 'payload');

  if (obj.kind !== WORKSHEET_KIND) {
    throw new WorksheetValidationError(`payload.kind must be '${WORKSHEET_KIND}'`);
  }
  if (obj.version !== definition.version) {
    throw new WorksheetValidationError(
      `payload.version ${String(obj.version)} does not match the published worksheet version ${definition.version}`
    );
  }

  const key = requireNonEmptyString(obj.submission_key, 'payload.submission_key', 26);
  if (!WORKSHEET_KEY_PATTERN.test(key)) {
    throw new WorksheetValidationError(
      'payload.submission_key must be a ULID (26 Crockford base32 chars)'
    );
  }

  if (!Array.isArray(obj.quantities)) {
    throw new WorksheetValidationError('payload.quantities must be an array');
  }
  const byLabel = new Map(definition.components.map((c) => [c.label, c]));
  const seen = new Set<string>();
  const quantities = obj.quantities.map((rawQty, i) => {
    const q = asRecord(rawQty, `payload.quantities[${i}]`);
    rejectUnknownKeys(q, ['label', 'quantity'], `payload.quantities[${i}]`);
    const label = requireNonEmptyString(q.label, `payload.quantities[${i}].label`, 200);
    if (!byLabel.has(label)) {
      throw new WorksheetValidationError(
        `payload.quantities[${i}].label '${label}' is not a component of the published worksheet`
      );
    }
    if (seen.has(label)) {
      throw new WorksheetValidationError(
        `payload.quantities[${i}].label '${label}' appears more than once`
      );
    }
    seen.add(label);
    const quantity = requireFiniteNumber(q.quantity, `payload.quantities[${i}].quantity`);
    if (quantity < 0 || quantity > WORKSHEET_MAX_QUANTITY) {
      throw new WorksheetValidationError(
        `payload.quantities[${i}].quantity must be between 0 and ${WORKSHEET_MAX_QUANTITY}`
      );
    }
    return { label, quantity };
  });

  const submission: WorksheetSubmission = {
    kind: WORKSHEET_KIND,
    version: WORKSHEET_VERSION,
    submission_key: key,
    quantities,
  };
  const note = optionalString(obj.note, 'payload.note', 10_000);
  if (note !== undefined) submission.note = note;
  return submission;
}

// ── Computation ──────────────────────────────────────────────────────────────

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Sum each field across components: `quantity / basis × per_basis[field]`.
 *
 * Null semantics mirror the rest of the toolkit's panel math: a component that
 * omits a field contributes **unknown** to it, and the field's total is `null`
 * only when NO component carried it. An unknown is never coerced to `0` —
 * "we don't know" and "there is none of it" are different facts, and conflating
 * them is how a total silently understates.
 */
export function computeWorksheetTotals(
  definition: WorksheetDefinition,
  quantities: { label: string; quantity: number }[]
): WorksheetTotals {
  const stated = new Map(quantities.map((q) => [q.label, q.quantity]));
  const sums = new Map<string, number>();

  for (const component of definition.components) {
    // An omitted component keeps its planned quantity — never 0. A submission
    // that didn't mention a row is one that left it as published, not one that
    // dropped the ingredient.
    const quantity = stated.get(component.label) ?? component.quantity;
    const factor = quantity / (definition.basis ?? 100);
    for (const [key, perBasis] of Object.entries(component.per_basis)) {
      sums.set(key, (sums.get(key) ?? 0) + perBasis * factor);
    }
  }

  const totals: WorksheetTotals = {};
  for (const field of definition.fields) {
    const sum = sums.get(field.key);
    totals[field.key] = sum === undefined ? null : roundTo(sum, field.precision ?? 1);
  }
  return totals;
}

/**
 * The canonical stored payload for a validated submission: the quantities as
 * stated (with omissions resolved to their planned values), the references they
 * were computed against, and the server-computed totals.
 */
export function normalizeWorksheetResponse(
  definition: WorksheetDefinition,
  submission: WorksheetSubmission
): WorksheetResponsePayload {
  const stated = new Map(submission.quantities.map((q) => [q.label, q.quantity]));
  const payload: WorksheetResponsePayload = {
    kind: WORKSHEET_KIND,
    version: WORKSHEET_VERSION,
    submission_key: submission.submission_key,
    basis: definition.basis ?? 100,
    unit: definition.unit ?? 'g',
    components: definition.components.map((c) => ({
      label: c.label,
      quantity: stated.get(c.label) ?? c.quantity,
      per_basis: { ...c.per_basis },
    })),
    totals: computeWorksheetTotals(definition, submission.quantities),
    note: submission.note ?? null,
  };
  if (definition.cook_mode) {
    payload.cook_mode = {
      disposition: definition.cook_mode.disposition,
      label: definition.cook_mode.label,
      // The submission key IS the kitchen-side ULID — see § Idempotency.
      ulid: submission.submission_key,
    };
  }
  return payload;
}

/** One-line human summary of a worksheet submission, used as the notify body. */
export function summarizeWorksheet(
  definition: WorksheetDefinition,
  payload: WorksheetResponsePayload
): string {
  const parts = definition.fields
    .slice(0, 3)
    .map((f) => {
      const value = payload.totals[f.key];
      return `${f.label} ${value === null ? '—' : value}${f.unit ? ` ${f.unit}` : ''}`;
    })
    .join(', ');
  const name = definition.cook_mode?.label ?? definition.heading ?? 'Worksheet';
  return `${name}: ${parts}`;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Embed JSON inside a `<script type="application/json">` block. Every `<` is
 * escaped to its u003c JSON escape, so no substring of the data can close the
 * element early — cheaper to reason about than pattern-matching `</script`.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const WORKSHEET_STYLES = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 0 auto; padding: 1rem 1rem 6rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .intro { color: #555; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.5rem 0.4rem; border-bottom: 1px solid #ddd; vertical-align: baseline; }
  th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; }
  td.qty { width: 8.5rem; white-space: nowrap; }
  input[type="number"] { width: 5.5rem; font-size: 1.1rem; padding: 0.35rem; }
  .cnote { display: block; font-size: 0.8rem; color: #777; }
  .totals { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; padding: 0.75rem; border: 1px solid #ccc; border-radius: 0.4rem; }
  .totals div { min-width: 5rem; }
  .totals dt { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; }
  .totals dd { margin: 0; font-size: 1.2rem; font-variant-numeric: tabular-nums; }
  ol.steps li { margin-bottom: 0.5rem; }
  textarea { width: 100%; min-height: 4rem; font: inherit; padding: 0.4rem; }
  button { font-size: 1.05rem; padding: 0.6rem 1.1rem; border-radius: 0.4rem; cursor: pointer; }
  button[disabled] { opacity: 0.55; cursor: progress; }
  #pw-status { margin-top: 1rem; padding: 0.75rem; border-radius: 0.4rem; border: 2px solid transparent; }
  #pw-status[data-state="ok"] { border-color: #1a7f37; background: rgba(26,127,55,0.08); }
  #pw-status[data-state="error"] { border-color: #b32020; background: rgba(179,32,32,0.08); }
  #pw-status[data-state="busy"] { border-color: #777; }
  #pw-status[data-state="idle"] { display: none; }
  #pw-status h2 { font-size: 1rem; margin: 0 0 0.25rem; }
  #pw-status p { margin: 0.25rem 0; }
  #pw-restore { margin: 0.5rem 0; }
`;

/**
 * Render the ONE canonical worksheet document. The definition is embedded as
 * JSON and driven by the shared runtime in `_helper.js` — the page carries no
 * bespoke arithmetic, which is the whole point of the pattern.
 */
export function renderWorksheetHtml(definition: WorksheetDefinition, title: string): string {
  const unit = definition.unit ?? 'g';
  const basis = definition.basis ?? 100;
  const heading = definition.heading ?? title;

  const rows = definition.components
    .map((c) => {
      const refs = definition.fields
        .filter((f) => c.per_basis[f.key] !== undefined)
        .map((f) => `${escapeHtml(f.label)} ${c.per_basis[f.key]}${f.unit ? escapeHtml(f.unit) : ''}`)
        .join(' · ');
      const readonly = c.editable === false ? ' readonly' : '';
      return `      <tr>
        <td>${escapeHtml(c.label)}${c.note ? `<span class="cnote">${escapeHtml(c.note)}</span>` : ''}<span class="cnote">per ${basis}${escapeHtml(unit)}: ${refs || '—'}</span></td>
        <td class="qty"><input type="number" inputmode="decimal" step="any" min="0" max="${WORKSHEET_MAX_QUANTITY}"
          data-pw-label="${escapeHtml(c.label)}" value="${c.quantity}"${readonly}> ${escapeHtml(unit)}</td>
      </tr>`;
    })
    .join('\n');

  const totals = definition.fields
    .map(
      (f) => `      <div><dt>${escapeHtml(f.label)}</dt><dd><span data-pw-total="${escapeHtml(f.key)}">—</span>${
        f.unit ? ` ${escapeHtml(f.unit)}` : ''
      }</dd></div>`
    )
    .join('\n');

  const steps = definition.steps?.length
    ? `  <h2>Steps</h2>
  <ol class="steps">
${definition.steps.map((s) => `    <li>${escapeHtml(s)}</li>`).join('\n')}
  </ol>
`
    : '';

  const submitLabel =
    definition.submit_label ??
    (definition.cook_mode
      ? definition.cook_mode.disposition === 'eaten'
        ? 'Log it'
        : 'Record the batch'
      : 'Submit');

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${WORKSHEET_STYLES}</style>
<h1>${escapeHtml(heading)}</h1>
${definition.intro ? `<p class="intro">${escapeHtml(definition.intro)}</p>\n` : ''}<div id="pw-restore" hidden></div>
<table>
  <thead><tr><th>Component</th><th>Actual</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<dl class="totals">
${totals}
</dl>
${steps}  <h2>${escapeHtml(definition.note_label ?? 'Notes')}</h2>
<textarea id="pw-note" placeholder="anything worth remembering"></textarea>
<p><button id="pw-submit" type="button">${escapeHtml(submitLabel)}</button></p>
<div id="pw-status" data-state="idle" role="status" aria-live="polite"></div>
<script type="application/json" id="pw-definition">${embedJson(definition)}</script>
<script src="/pages/_helper.js"></script>
<script>window.pagesWorksheetInit();</script>
`;
}
