/**
 * Kitchen routes — registered under the server's /api prefix → /api/kitchen.
 *
 * POST   /kitchen/entries              - multipart: entry JSON part + 0..N photo parts
 * GET    /kitchen/entries              - list (since/limit; client sync)
 * GET    /kitchen/entries/:ulid        - single entry
 * PATCH  /kitchen/entries/:ulid        - note/label re-queue, or a terminal macro override
 * DELETE /kitchen/entries/:ulid        - remove from all rollups
 * GET    /kitchen/reselect             - recipes (sheet+pushed+promoted) merged with recent items
 * POST   /kitchen/recipes              - agent-pushed template; UPSERTS (201 create / 200 replace / 409 collision)
 * DELETE /kitchen/recipes/:ulid        - archives a recipe (soft; still resolvable by ULID)
 * POST   /kitchen/entries/:ulid/promote - creates a recipe from a logged entry
 *
 * Photos never touch disk: @fastify/multipart's `toBuffer()` holds each
 * photo in memory only for the duration of the request handler.
 */

import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { installStrictValidation } from '../strict-validation.js';
import { ULID_PATTERN } from '../ulid.js';
import { InvalidTransitionError } from '../state.js';
import {
  ConflictingSourceError,
  ManualOverrideConflictError,
  PatchValidationError,
  PromoteNotReadyError,
  RecipeNameConflictError,
  RecipeNotFoundError,
  SourceEntryNotFoundError,
  type KitchenPipeline,
} from '../services/pipeline.js';
import { NUTRITION_FIELD_KEYS, PORTION_MULTIPLIER_MAX } from '../types.js';
import type {
  ComponentQuantity,
  EntryInput,
  EntryPatchInput,
  EntryRecord,
  PhotoPart,
  RecipeComponent,
  StatedMacros,
} from '../types.js';
import { localDay, localDisplay, resolveOwnerTz, type OwnerTz } from '../zoned.js';

/**
 * The eight panel fields accepted on a directly-stated `macros` object
 * (specs/modules/kitchen.md § Directly-stated panel entries). Mirrors the panel
 * everywhere else; `confidence`/`portion_basis` are never client-stated (they
 * describe an estimate, and a stated panel has none).
 */
const STATED_MACRO_KEYS: readonly (keyof StatedMacros)[] = NUTRITION_FIELD_KEYS;

function validateStatedMacros(
  value: unknown
): { ok: true; value: StatedMacros } | { ok: false; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'entry.macros must be a JSON object of panel fields' };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set<string>(STATED_MACRO_KEYS);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `entry.macros has unknown field "${key}" (allowed: ${STATED_MACRO_KEYS.join(', ')})` };
    }
  }
  const out: StatedMacros = {};
  for (const key of STATED_MACRO_KEYS) {
    const v = obj[key];
    if (v === undefined) continue; // absent → stored null, never 0
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { ok: false, error: `entry.macros.${key} must be a non-negative number when present` };
    }
    out[key] = v;
  }
  return { ok: true, value: out };
}

export interface KitchenRoutesConfig {
  pipeline: KitchenPipeline;
  /** Max bytes per uploaded photo (default 10 MiB). */
  maxPhotoBytes?: number;
  /** Max photo parts per entry (default 6). */
  maxPhotos?: number;
  /**
   * Owner timezone (§ Timezone & local-day bucketing) — used to stamp each
   * entry's owner-local `day` and local-time display server-side. Optional so
   * tests can omit it; absent ⇒ UTC fallback.
   */
  ownerTz?: OwnerTz;
}

/**
 * Serialize an entry for the wire, adding the module-owned local-day fields
 * (§ Timezone & local-day bucketing): `day` (owner-tz calendar date, the
 * authoritative bucketing key) and `logged_local` (the instant rendered in the
 * owner zone with an explicit offset — never a bare `Z`). The raw `logged_at`
 * UTC instant stays for ordering/machine use.
 */
function serializeEntry(entry: EntryRecord, ownerTz: OwnerTz): Record<string, unknown> {
  const loggedAt = entry.logged_at instanceof Date ? entry.logged_at : new Date(entry.logged_at);
  return {
    ...entry,
    day: localDay(loggedAt, ownerTz.zone),
    logged_local: localDisplay(loggedAt, ownerTz.zone),
  };
}

function validateComponentQuantities(value: unknown): value is ComponentQuantity[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (q) =>
      q &&
      typeof q === 'object' &&
      typeof (q as Record<string, unknown>).label === 'string' &&
      typeof (q as Record<string, unknown>).quantity_g === 'number'
  );
}

function validateEntryInput(input: unknown): { ok: true; value: EntryInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'entry part must be a JSON object' };
  const obj = input as Record<string, unknown>;

  if (typeof obj.ulid !== 'string' || !ULID_PATTERN.test(obj.ulid)) {
    return { ok: false, error: 'entry.ulid is required and must be a valid ULID' };
  }
  if (obj.logged_at !== undefined && typeof obj.logged_at !== 'string') {
    return { ok: false, error: 'entry.logged_at must be an ISO date-time string' };
  }
  if (obj.note !== undefined && typeof obj.note !== 'string') {
    return { ok: false, error: 'entry.note must be a string' };
  }
  if (obj.recipe_ulid !== undefined && (typeof obj.recipe_ulid !== 'string' || !ULID_PATTERN.test(obj.recipe_ulid))) {
    return { ok: false, error: 'entry.recipe_ulid must be a valid ULID' };
  }
  if (obj.reselect_of !== undefined && (typeof obj.reselect_of !== 'string' || !ULID_PATTERN.test(obj.reselect_of))) {
    return { ok: false, error: 'entry.reselect_of must be a valid ULID' };
  }
  if (obj.recipe_ulid !== undefined && obj.reselect_of !== undefined) {
    return { ok: false, error: 'entry.recipe_ulid and entry.reselect_of are mutually exclusive' };
  }
  if (obj.component_quantities !== undefined && !validateComponentQuantities(obj.component_quantities)) {
    return { ok: false, error: 'entry.component_quantities entries need a string label and numeric quantity_g' };
  }

  // Directly-stated panel (specs/modules/kitchen.md § Directly-stated panel
  // entries): a `macros` object is a creation shape mutually exclusive with
  // every other. Photo mutual-exclusion is enforced in the handler (photos are
  // separate multipart parts, not part of this JSON object).
  let macros: StatedMacros | undefined;
  if (obj.macros !== undefined) {
    if (obj.recipe_ulid !== undefined || obj.reselect_of !== undefined || obj.component_quantities !== undefined) {
      return {
        ok: false,
        error: 'entry.macros is mutually exclusive with recipe_ulid, reselect_of, and component_quantities',
      };
    }
    const validatedMacros = validateStatedMacros(obj.macros);
    if (!validatedMacros.ok) return { ok: false, error: validatedMacros.error };
    macros = validatedMacros.value;
  }

  // A label is honored only alongside a directly-stated panel; elsewhere the
  // label comes from the source, so reject it rather than silently drop it.
  if (obj.label !== undefined) {
    if (typeof obj.label !== 'string') {
      return { ok: false, error: 'entry.label must be a string' };
    }
    if (macros === undefined) {
      return { ok: false, error: 'entry.label is only valid alongside a macros panel' };
    }
  }

  return {
    ok: true,
    value: {
      ulid: obj.ulid,
      logged_at: obj.logged_at as string | undefined,
      note: obj.note as string | undefined,
      recipe_ulid: obj.recipe_ulid as string | undefined,
      component_quantities: obj.component_quantities as ComponentQuantity[] | undefined,
      reselect_of: obj.reselect_of as string | undefined,
      macros,
      label: obj.label as string | undefined,
    },
  };
}

const PATCH_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    note: { type: 'string', maxLength: 2000 },
    label: { type: 'string', maxLength: 200 },
    calories: { type: 'number', minimum: 0 },
    protein_g: { type: 'number', minimum: 0 },
    fat_g: { type: 'number', minimum: 0 },
    sat_fat_g: { type: 'number', minimum: 0 },
    carbs_g: { type: 'number', minimum: 0 },
    sugar_g: { type: 'number', minimum: 0 },
    added_sugar_g: { type: 'number', minimum: 0 },
    fiber_g: { type: 'number', minimum: 0 },
    sodium_mg: { type: 'number', minimum: 0 },
    portion_basis: { type: 'string', maxLength: 200 },
    // Post-hoc rescale of the base macros (specs/modules/kitchen.md § Portion
    // multiplier): 0 < m <= PORTION_MULTIPLIER_MAX. exclusiveMinimum keeps 0 out.
    portion_multiplier: { type: 'number', exclusiveMinimum: 0, maximum: PORTION_MULTIPLIER_MAX },
    // Post-hoc backdating (specs/modules/kitchen.md § Logged-at backdating). The
    // schema only pins the wire TYPE; parse + clock-relative bounds live in the
    // pipeline (they need `now`), which throws PatchValidationError → 400.
    logged_at: { type: 'string' },
  },
} as const;

const RECIPE_COMPONENT_SCHEMA = {
  type: 'object',
  required: ['label', 'default_qty_g', 'per_100g'],
  additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 200 },
    default_qty_g: { type: 'number', minimum: 0 },
    per_100g: {
      type: 'object',
      required: ['calories', 'protein_g', 'sat_fat_g'],
      additionalProperties: false,
      properties: {
        calories: { type: 'number', minimum: 0 },
        protein_g: { type: 'number', minimum: 0 },
        sat_fat_g: { type: 'number', minimum: 0 },
        // Optional full-panel extension (§ Nutrition panel) — a component that
        // omits a field contributes "unknown" to that field's total, not zero.
        fat_g: { type: ['number', 'null'], minimum: 0 },
        carbs_g: { type: ['number', 'null'], minimum: 0 },
        sugar_g: { type: ['number', 'null'], minimum: 0 },
        added_sugar_g: { type: ['number', 'null'], minimum: 0 },
        fiber_g: { type: ['number', 'null'], minimum: 0 },
        sodium_mg: { type: ['number', 'null'], minimum: 0 },
      },
    },
  },
} as const;

const RECIPES_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    // Optional idempotency/replace key (specs/modules/kitchen.md § Recipe
    // corrections): supplied, it create-or-replaces THAT record; omitted, the
    // normalized name is the key.
    ulid: { type: 'string', pattern: ULID_PATTERN.source },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    components: { type: 'array', maxItems: 50, items: RECIPE_COMPONENT_SCHEMA },
  },
} as const;

function validatePromoteBody(value: unknown): { ok: true } | { ok: false; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'body must be an object' };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => k !== 'name')) {
    return { ok: false, error: 'body may only contain a "name" field' };
  }
  if (obj.name !== undefined && (typeof obj.name !== 'string' || !obj.name.trim())) {
    return { ok: false, error: 'name must be a non-empty string' };
  }
  return { ok: true };
}

export const registerKitchenRoutes: FastifyPluginAsync<KitchenRoutesConfig> = async (
  fastify,
  { pipeline, maxPhotoBytes = 10 * 1024 * 1024, maxPhotos = 6, ownerTz = resolveOwnerTz() }
) => {
  // specs/modules/kitchen.md § Request validation is strict, not permissive
  installStrictValidation(fastify);

  await fastify.register(multipart, {
    limits: { fileSize: maxPhotoBytes, files: maxPhotos, fields: 4 },
  });

  // POST /kitchen/entries - multipart: entry JSON part + 0..N photo parts.
  fastify.post('/kitchen/entries', async (request, reply) => {
    if (!request.isMultipart()) {
      reply.status(400);
      return { error: 'multipart/form-data required (entry JSON part + optional photo parts)' };
    }

    let parsedEntry: unknown;
    const photos: PhotoPart[] = [];

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          if (part.fieldname === 'photo' || part.fieldname === 'photos') {
            photos.push({ data: buffer, mimeType: part.mimetype });
          } else if (part.fieldname === 'entry') {
            // Some multipart clients ship the JSON metadata part with a
            // filename, which classifies it as a file part — accept the
            // entry either way.
            try {
              parsedEntry = JSON.parse(buffer.toString('utf8'));
            } catch {
              reply.status(400);
              return { error: 'entry field must be valid JSON' };
            }
          }
          // Other unknown file fields are drained (toBuffer already consumed
          // the stream) and otherwise ignored — never written to disk either way.
        } else if (part.fieldname === 'entry') {
          try {
            parsedEntry = JSON.parse(part.value as string);
          } catch {
            reply.status(400);
            return { error: 'entry field must be valid JSON' };
          }
        }
      }
    } catch (err) {
      reply.status(400);
      return { error: `multipart parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (parsedEntry === undefined) {
      reply.status(400);
      return { error: 'missing entry field (multipart part named "entry")' };
    }

    const validated = validateEntryInput(parsedEntry);
    if (!validated.ok) {
      reply.status(400);
      return { error: validated.error };
    }

    // A directly-stated panel is mutually exclusive with photos (§ Directly-
    // stated panel entries): there is nothing to estimate, so an attached image
    // is a contradiction, not a fallback.
    if (validated.value.macros && photos.length > 0) {
      reply.status(400);
      return { error: 'entry.macros is mutually exclusive with photo parts' };
    }

    try {
      const { record, created, estimation } = await pipeline.ingest(validated.value, photos);
      if (estimation) {
        void estimation.catch((error) =>
          request.log.error({ error }, 'Detached kitchen estimation rejected')
        );
      }
      reply.status(created ? 201 : 200);
      return serializeEntry(record, ownerTz);
    } catch (err) {
      if (
        err instanceof RecipeNotFoundError ||
        err instanceof SourceEntryNotFoundError ||
        err instanceof ConflictingSourceError
      ) {
        reply.status(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  // GET /kitchen/entries - newest-first listing for client sync.
  fastify.get<{ Querystring: { since?: string; limit?: string } }>(
    '/kitchen/entries',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            since: { type: 'string', format: 'date-time' },
            limit: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request) => {
      const since = request.query.since ? new Date(request.query.since) : undefined;
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const entries = await pipeline.list({ since, limit });
      return {
        entries: entries.map((e) => serializeEntry(e, ownerTz)),
        count: entries.length,
        tz: ownerTz.note,
      };
    }
  );

  // GET /kitchen/reselect - the strip: recipes merged with recent/frequent logged items.
  // Static path registered ahead of /kitchen/entries/:ulid; find-my-way matches
  // literal segments before params regardless of registration order, but this
  // mirrors capture's /capture/references-before-:ulid convention for clarity.
  fastify.get<{ Querystring: { limit?: string } }>(
    '/kitchen/reselect',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      return pipeline.reselect(limit);
    }
  );

  // GET /kitchen/entries/:ulid
  fastify.get<{ Params: { ulid: string } }>('/kitchen/entries/:ulid', async (request, reply) => {
    const entry = await pipeline.get(request.params.ulid);
    if (!entry) {
      reply.status(404);
      return { error: 'Entry not found' };
    }
    return serializeEntry(entry, ownerTz);
  });

  // PATCH /kitchen/entries/:ulid
  fastify.patch<{ Params: { ulid: string }; Body: EntryPatchInput }>(
    '/kitchen/entries/:ulid',
    { schema: { body: PATCH_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const updated = await pipeline.patch(request.params.ulid, request.body ?? {});
        if (!updated) {
          reply.status(404);
          return { error: 'Entry not found' };
        }
        return serializeEntry(updated, ownerTz);
      } catch (err) {
        if (err instanceof ManualOverrideConflictError) {
          reply.status(409);
          return { error: err.message };
        }
        if (err instanceof PatchValidationError || err instanceof InvalidTransitionError) {
          reply.status(400);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // DELETE /kitchen/entries/:ulid
  fastify.delete<{ Params: { ulid: string } }>('/kitchen/entries/:ulid', async (request, reply) => {
    const removed = await pipeline.delete(request.params.ulid);
    if (!removed) {
      reply.status(404);
      return { error: 'Entry not found' };
    }
    reply.status(204);
    return null;
  });

  // POST /kitchen/recipes - agent-pushed one-off or reusable template.
  // Upserts (specs/modules/kitchen.md § Recipe corrections): 201 on create, 200
  // on replace, 409 on a name collision it must not resolve by guessing.
  fastify.post<{ Body: { ulid?: string; name: string; components?: RecipeComponent[] } }>(
    '/kitchen/recipes',
    { schema: { body: RECIPES_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const { recipe, created } = await pipeline.pushRecipe(request.body);
        reply.status(created ? 201 : 200);
        return recipe;
      } catch (err) {
        if (err instanceof RecipeNameConflictError) {
          reply.status(409);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // DELETE /kitchen/recipes/:ulid - ARCHIVES the recipe (§ Recipe corrections).
  // Never a row deletion: entries, promotions, and derived-item provenance all
  // point at recipes and must keep resolving. Idempotent; 404 for an unknown
  // ULID, including a sheet-sourced one (no row here to retire).
  fastify.delete<{ Params: { ulid: string } }>('/kitchen/recipes/:ulid', async (request, reply) => {
    const archived = await pipeline.archiveRecipe(request.params.ulid);
    if (!archived) {
      reply.status(404);
      return {
        error:
          'Recipe not found. Sheet-sourced recipes are a read-through projection of the meal-bank sheet and cannot be archived here.',
      };
    }
    return archived;
  });

  // POST /kitchen/entries/:ulid/promote - creates a recipe from a logged entry.
  // No body schema: the body is entirely optional (a bare POST with no
  // payload is a valid "promote with the entry's own label" call), and
  // fastify's ajv body validation rejects a `type: object` schema against
  // a genuinely bodyless request.
  fastify.post<{ Params: { ulid: string }; Body: { name?: string } | undefined }>(
    '/kitchen/entries/:ulid/promote',
    async (request, reply) => {
      if (request.body !== undefined) {
        const validated = validatePromoteBody(request.body);
        if (!validated.ok) {
          reply.status(400);
          return { error: validated.error };
        }
      }
      try {
        const recipe = await pipeline.promote(request.params.ulid, (request.body as { name?: string })?.name);
        if (!recipe) {
          reply.status(404);
          return { error: 'Entry not found' };
        }
        reply.status(201);
        return recipe;
      } catch (err) {
        if (err instanceof PromoteNotReadyError || err instanceof RecipeNameConflictError) {
          reply.status(409);
          return { error: err.message };
        }
        throw err;
      }
    }
  );
};
