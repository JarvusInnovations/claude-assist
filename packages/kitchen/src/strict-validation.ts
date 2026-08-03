/**
 * Strict request-schema validation for the kitchen module's own Fastify
 * sub-contexts (specs/modules/kitchen.md § Request validation is strict, not
 * permissive).
 *
 * Every write body/querystring schema in this module declares
 * `additionalProperties: false`, which reads as "reject anything not listed."
 * Fastify's default AJV compiler (`@fastify/ajv-compiler`) sets
 * `removeAdditional: true`, and that combination is documented upstream AJV
 * behavior for a different purpose: SILENTLY STRIP unmatched keys rather than
 * fail validation. A caller who sends `nutrition` where the schema wants
 * `nutrition_per_100g` gets a `200`, the rest of the body applied, and the
 * misnamed field discarded with no trace — indistinguishable from every other
 * legal partial PATCH this module makes on purpose.
 *
 * `installStrictValidation` swaps in a validator compiled with
 * `removeAdditional: false` (so `additionalProperties: false` actually
 * rejects) and a matching error handler that turns AJV's generic "must NOT
 * have additional properties" into a message naming the offending key(s) and,
 * where an unlisted key is an obvious near-miss of a real one, what it
 * probably meant.
 *
 * Call once per encapsulated Fastify context, before any routes are declared
 * on it — every kitchen route-registration function calls this as its first
 * statement, so the guarantee holds regardless of whether the file is
 * mounted under the module's top-level plugin or registered directly (as the
 * test suite does).
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { FastifyError, FastifyInstance, FastifySchema } from 'fastify';

// Mirrors @fastify/ajv-compiler's own defaults (coerceTypes/useDefaults/
// allErrors, and registering ajv-formats so `format: 'date-time'` etc. keep
// working) with one deliberate change: removeAdditional false, so an
// additionalProperties:false schema REJECTS instead of silently stripping.
// verbose:true is what lets the error handler read `parentSchema.properties`
// off each AJV error to build the near-miss suggestion.
const ajv = new Ajv({
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: false,
  allErrors: true,
  verbose: true,
});
addFormats(ajv);

const compiledCache = new WeakMap<FastifySchema, ValidateFunction>();

function compile(schema: FastifySchema): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  const validate = ajv.compile(schema);
  compiledCache.set(schema, validate);
  return validate;
}

/** Classic edit distance — schema key lists here are short enough that the O(n*m) table is fine. */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  // One row at a time, seeded to `cols`, so every read is on an index this
  // function itself just wrote — no `noUncheckedIndexedAccess` fights.
  let prevRow: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const currRow: number[] = [i];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = prevRow[j]! + 1;
      const insertion = currRow[j - 1]! + 1;
      const substitution = prevRow[j - 1]! + cost;
      currRow.push(Math.min(deletion, insertion, substitution));
    }
    prevRow = currRow;
  }
  return prevRow[cols - 1]!;
}

type JsonSchemaLike = { type?: string | string[]; properties?: Record<string, unknown> };

/** The JSON-Schema `type` keyword this JS value would satisfy (AJV's `integer` accepts any whole `number`). */
function runtimeTypesOf(value: unknown): string[] {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array'];
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? ['number', 'integer'] : ['number'];
  return [t];
}

function acceptsRuntimeType(propSchema: unknown, types: string[]): boolean {
  const declared = (propSchema as JsonSchemaLike | undefined)?.type;
  if (!declared) return true; // schema doesn't constrain type — nothing to rule out on this basis
  const declaredList = Array.isArray(declared) ? declared : [declared];
  return declaredList.some((d) => types.includes(d));
}

/**
 * Count of the offending object's own keys that also appear as a nested
 * property on a candidate's schema — how well an object-shaped value's
 * fields line up with a candidate key's expected shape. `nutrition_per_100g`
 * and `nutrition_per_serving` share one panel schema, so this alone won't
 * pick between them (by design — see the tie handling below).
 */
function keyOverlapScore(offendingValue: unknown, candidateSchema: unknown): number {
  if (offendingValue === null || typeof offendingValue !== 'object' || Array.isArray(offendingValue)) return 0;
  const nestedProps = (candidateSchema as JsonSchemaLike | undefined)?.properties;
  if (!nestedProps) return 0;
  const nestedKeys = new Set(Object.keys(nestedProps));
  return Object.keys(offendingValue).filter((k) => nestedKeys.has(k)).length;
}

/**
 * The real key(s) an unrecognized one probably meant, or `[]` when nothing is
 * a plausible match. A prefix relationship is the strong signal (catches
 * `nutrition` → `nutrition_per_100g`, the field name this module actually
 * shipped); among prefix matches, the offending value's own shape (its JSON
 * type, and — for an object — which candidate's nested fields its keys
 * overlap) narrows further. Ties are reported together rather than guessing
 * one (`nutrition_per_100g` and `nutrition_per_serving` share one panel
 * schema — a caller who wrote `nutrition` could plausibly mean either).
 * Failing any prefix relationship, a short edit distance catches plain typos.
 * Never guesses across a large distance — a wrong suggestion costs more than
 * none.
 */
function nearestKnownKeys(unknownKey: string, knownProperties: Record<string, unknown>, offendingValue: unknown): string[] {
  const knownKeys = Object.keys(knownProperties);
  const prefixMatches = knownKeys.filter(
    (k) => k !== unknownKey && (k.startsWith(unknownKey) || unknownKey.startsWith(k))
  );
  if (prefixMatches.length > 0) {
    const runtimeTypes = runtimeTypesOf(offendingValue);
    const typeMatched = prefixMatches.filter((k) => acceptsRuntimeType(knownProperties[k], runtimeTypes));
    const pool = typeMatched.length > 0 ? typeMatched : prefixMatches;
    const scored = pool.map((k) => ({ k, score: keyOverlapScore(offendingValue, knownProperties[k]) }));
    const topScore = Math.max(...scored.map((s) => s.score));
    const top = scored.filter((s) => s.score === topScore).map((s) => s.k);
    // Among ties, shortest first — the least surprising guess.
    return top.sort((a, b) => a.length - b.length);
  }
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const k of knownKeys) {
    const d = levenshtein(unknownKey, k);
    if (d < bestDistance) {
      bestDistance = d;
      best = k;
    }
  }
  return best !== undefined && bestDistance <= 2 ? [best] : [];
}

/** Builds the "unrecognized field" message from AJV's additionalProperties errors, or undefined if none apply. */
function describeUnknownKeys(errors: ErrorObject[]): string | undefined {
  const additionalPropertyErrors = errors.filter((e) => e.keyword === 'additionalProperties');
  if (additionalPropertyErrors.length === 0) return undefined;

  const parts = additionalPropertyErrors.map((e) => {
    const key = (e.params as { additionalProperty: string }).additionalProperty;
    const parentSchema = e.parentSchema as JsonSchemaLike | undefined;
    const knownProperties = parentSchema?.properties ?? {};
    const offendingValue = (e.data as Record<string, unknown> | undefined)?.[key];
    const suggestions = nearestKnownKeys(key, knownProperties, offendingValue);
    const where = e.instancePath ? ` (at "${e.instancePath}")` : '';
    if (suggestions.length === 0) return `"${key}"${where} is not a recognized field`;
    const guess = suggestions.map((s) => `"${s}"`).join(' or ');
    return `"${key}"${where} is not a recognized field — did you mean ${guess}?`;
  });

  return parts.length === 1 ? parts[0] : parts.join('; ');
}

/**
 * Install the strict validator + the unknown-key error message on a fastify
 * (sub)instance. Idempotent to call more than once on the same instance.
 */
export function installStrictValidation(fastify: FastifyInstance): void {
  fastify.setValidatorCompiler(({ schema }) => compile(schema as FastifySchema));

  fastify.setErrorHandler((err: FastifyError, _request, reply) => {
    if (err.validation && err.validation.length > 0) {
      const message = describeUnknownKeys(err.validation as ErrorObject[]);
      if (message) {
        const part = err.validationContext ?? 'request';
        reply.status(400);
        return { error: `Invalid ${part}: ${message}` };
      }
    }
    // Not an unknown-key case (a genuine type/enum/etc. validation failure,
    // or an unrelated error) — defer to Fastify's normal handling.
    reply.send(err);
  });
}
