/**
 * Cook mode — the kitchen module's sink for worksheet submissions
 * (specs/modules/kitchen.md § Cook mode, specs/modules/pages.md § Cook mode).
 *
 * Submitting a prep worksheet IS the log. Before this existed, a submission sat
 * in the page's response queue until an agent noticed it and logged it by hand;
 * that delay is where meals got lost. Cook mode closes the loop synchronously,
 * on the existing endpoints rather than a parallel one:
 *
 * - **eaten** → a directly-stated panel entry (§ Directly-stated panel entries):
 *   born `manual`, terminal, no estimator, no birth race. The worksheet already
 *   computed the panel; re-guessing it would be strictly worse.
 * - **packed** → a `convert` (§ Conversions): sources decremented, a derived
 *   item created with its recipe attached. Nothing is logged as consumption —
 *   the batch is logged at EAT time via `consume`.
 *
 * That split is doctrine, not plumbing: **packing is a conversion, eating is an
 * entry.** A packed batch is stock that will be eaten later, possibly not as
 * planned; pre-logging it makes the journal lie the moment plans change.
 *
 * The single ULID a worksheet submission carries is the idempotency key for
 * whichever write it maps to — the entry's ULID when eaten, the derived item's
 * when packed — so a flaky-network resubmission can neither double-log nor
 * double-decrement. The key is minted PER SUBMISSION by the page runtime
 * (specs/modules/pages.md § Idempotency); a reused key whose stated panel
 * differs from what the key already wrote is a CONFLICT, not a replay — the
 * sink refuses rather than report the old entry as "already recorded".
 */

import {
  WorksheetCookConflictError,
  type WorksheetCookDecrements,
  type WorksheetCookOutcome,
  type WorksheetCookRequest,
  type WorksheetCookSink,
} from '@jarvus/claude-assist-core';
import { NUTRITION_FIELD_KEYS, type NutritionFields, type StatedMacros } from '../types.js';
import { SHELF_LIFE_CLASSES, type ShelfLifeClass } from '../inventory-types.js';
import { isValidUlid } from '../ulid.js';

/** A cook-mode request the kitchen module cannot honor as stated. */
export class CookModeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookModeValidationError';
  }
}

/** Only what cook mode actually calls, so tests can stand in a stub. */
export interface CookModeEntryIngest {
  ingest(
    input: {
      ulid: string;
      logged_at?: string;
      note?: string;
      /** The submitter wrote free text of their own — see § Unreviewed entry notes. */
      human_note?: boolean;
      label?: string;
      macros?: StatedMacros;
    },
    photos: never[]
  ): Promise<{
    /**
     * The entry as stored. On a replay (`created: false`) the panel fields
     * are what the key already wrote, and cook mode compares them against
     * the panel it was asked to write (§ Cook mode — a replayed key with a
     * different panel is a conflict). A stub may omit them.
     */
    record: { ulid: string } & Partial<NutritionFields>;
    created: boolean;
  }>;
  /**
   * Record decrements that could not be applied, so they surface in the
   * entries question queue rather than vanishing.
   */
  flagUnappliedDecrements?(ulid: string, unapplied: string[]): Promise<void>;
}

/**
 * The depletion seam for an EATEN sheet (§ Eaten sheets decrement their
 * sources). Deliberately two narrow verbs rather than the inventory service:
 * cook mode should be able to state what it wants without reaching into
 * inventory's surface.
 */
export interface CookModeDepleter {
  /** Divisible item, stated mass. Throws when the product has no mass basis. */
  consumeStated(
    itemUlid: string,
    input: { amount_g: number; entry_ulid: string; at?: string }
  ): Promise<unknown>;
  /** Counted item, one whole unit. Called once per unit. */
  finishUnit(itemUlid: string, input: { at?: string }): Promise<unknown>;
}

export interface CookModeConverter {
  convert(input: {
    sources?: { item_ulid: string; amount?: number; amount_g?: number }[];
    derived: {
      ulid?: string;
      name: string;
      shelf_life_class?: ShelfLifeClass;
      units_total?: number;
      notes?: string | null;
      acquired_at?: string;
      recipe_ulid?: string | null;
    };
    at?: string;
  }): Promise<{ derived: { ulid: string }; created: boolean }>;
}

/**
 * Turn the worksheet's computed totals into a directly-stated panel.
 *
 * The worksheet's field keys are arbitrary strings by design (the pages module
 * owns no nutrition vocabulary), so validating them against the real panel is
 * this module's job — and it REJECTS an unknown key rather than dropping it. A
 * silently-ignored field would log a meal whose numbers quietly disagree with
 * what the submitter watched add up on screen, which is the exact class of
 * defect cook mode exists to remove.
 */
export function totalsToStatedMacros(totals: Record<string, number | null>): StatedMacros {
  const panel: Record<string, number> = {};
  const known = new Set<string>(NUTRITION_FIELD_KEYS);
  for (const [key, value] of Object.entries(totals)) {
    if (!known.has(key)) {
      throw new CookModeValidationError(
        `cook mode cannot log field '${key}': not a nutrition panel field (${NUTRITION_FIELD_KEYS.join(', ')})`
      );
    }
    // A null total is UNKNOWN, and an unstated panel field is stored null —
    // so omitting it here is exactly right. Never coerce it to 0.
    if (value !== null) panel[key] = value;
  }
  if (Object.keys(panel).length === 0) {
    throw new CookModeValidationError('cook mode requires at least one known nutrition total');
  }
  return panel as StatedMacros;
}

/** `label · 76 g oats · 120 g yogurt` — the measured provenance, as text. */
export function measuredNote(request: WorksheetCookRequest): string {
  const measured = request.components
    .map((c) => `${c.quantity}${request.unit} ${c.label}`)
    .join(', ');
  const remark = request.note?.trim();
  const base = `worksheet: ${measured}`;
  return remark ? `${remark}\n\n${base}` : base;
}

export interface CookModeConfig {
  entries: CookModeEntryIngest;
  inventory: CookModeConverter;
  /** Absent → decrements are all reported unapplied rather than attempted. */
  depleter?: CookModeDepleter;
}

/**
 * The `WorksheetCookSink` the server injects into the pages module. Nothing
 * here is pages-aware beyond the core-owned request/outcome types — the two
 * packages never import each other.
 */
export class KitchenCookMode implements WorksheetCookSink {
  constructor(private config: CookModeConfig) {}

  async cook(request: WorksheetCookRequest): Promise<WorksheetCookOutcome> {
    if (!isValidUlid(request.ulid)) {
      throw new CookModeValidationError(`cook mode requires a ULID key, got: ${request.ulid}`);
    }
    if (!request.label.trim()) {
      throw new CookModeValidationError('cook mode requires a non-empty label');
    }
    return request.disposition === 'eaten' ? this.logEaten(request) : this.recordPacked(request);
  }

  /**
   * An eaten meal is an ENTRY. The panel is stated verbatim, so the entry is
   * born `manual`/terminal and no estimation job is ever enqueued — there is
   * nothing that could later land and clobber the numbers the submitter saw.
   *
   * Inventory is deliberately NOT decremented here. Cook mode maps each
   * disposition to exactly ONE atomic write, so there is no "entry landed,
   * decrement failed" half-state to explain: depletion for an eaten meal
   * happens through the eaten-decrement bindings below, and for a prepped item
   * through `consume` at eat time.
   */
  private async logEaten(request: WorksheetCookRequest): Promise<WorksheetCookOutcome> {
    const macros = totalsToStatedMacros(request.totals);
    const { record, created } = await this.config.entries.ingest(
      {
        ulid: request.ulid,
        ...(request.at ? { logged_at: request.at } : {}),
        note: measuredNote(request),
        // The stored note ALWAYS has content (the measured-provenance manifest
        // is appended unconditionally), so note-presence cannot distinguish a
        // human remark — every cook-mode entry would flag. The submitter's own
        // free text is the only human statement here, and only it queues a
        // question (§ Unreviewed entry notes).
        human_note: Boolean(request.note?.trim()),
        label: request.label.trim(),
        macros,
      },
      []
    );

    if (!created) {
      // A replayed key is a safe no-op ONLY when it is asking for the same
      // write. The page runtime mints one key per submission, so a reused key
      // with a different panel means the runtime (or a stale draft) has handed
      // a second real meal the first meal's identity — and answering "already
      // recorded" would put a checkmark over numbers the ledger does not hold.
      assertSamePanel(record, macros, request.ulid);
      return { kind: 'entry', ulid: record.ulid, created };
    }

    // Decrements run AFTER the entry, and never roll it back
    // (§ The entry is authoritative). A meal that refused to record because a
    // bag lacked a net weight would be a strictly worse ledger than one that
    // records and flags the gap.
    const decrements = await this.applyConsumes(request, record.ulid);
    if (decrements.unapplied.length > 0) {
      // Surfaced, never swallowed: an invisible skip would reproduce exactly
      // the drift this feature removes while looking fixed. The entry note
      // and question queue get the text; the outcome carries the structure
      // so the page can render it where the submitter is standing.
      await this.config.entries.flagUnappliedDecrements?.(
        record.ulid,
        decrements.unapplied.map(describeUnapplied)
      );
    }

    return { kind: 'entry', ulid: record.ulid, created, decrements };
  }

  /**
   * Apply each binding at its SUBMITTED quantity. Returns what moved and what
   * did not, each refusal with the module's own reason.
   */
  private async applyConsumes(
    request: WorksheetCookRequest,
    entryUlid: string
  ): Promise<WorksheetCookDecrements> {
    const decrements: WorksheetCookDecrements = { applied: [], unapplied: [] };
    const quantities = new Map<string, number>(
      request.components.map((c) => [c.label, c.quantity] as [string, number])
    );

    for (const bind of request.consumes ?? []) {
      const quantity = quantities.get(bind.component);
      if (quantity === undefined) {
        decrements.unapplied.push({
          component: bind.component,
          item_ulid: bind.item_ulid,
          quantity: null,
          reason: 'no submitted quantity',
        });
        continue;
      }
      if (quantity <= 0) continue; // Nothing eaten, nothing to take off.
      if (!this.config.depleter) {
        decrements.unapplied.push({
          component: bind.component,
          item_ulid: bind.item_ulid,
          quantity,
          reason: 'no depleter configured',
        });
        continue;
      }

      try {
        if (bind.model === 'counted') {
          // Whole units only — a fractional unit is not a thing you can eat
          // off a counted item, and rounding one would invent stock movement.
          const units = Math.round(quantity);
          for (let i = 0; i < units; i++) {
            await this.config.depleter.finishUnit(bind.item_ulid, {
              ...(request.at ? { at: request.at } : {}),
            });
          }
          decrements.applied.push({
            component: bind.component,
            item_ulid: bind.item_ulid,
            quantity: units,
            unit: 'unit',
          });
        } else {
          await this.config.depleter.consumeStated(bind.item_ulid, {
            amount_g: quantity,
            entry_ulid: entryUlid,
            ...(request.at ? { at: request.at } : {}),
          });
          decrements.applied.push({
            component: bind.component,
            item_ulid: bind.item_ulid,
            quantity,
            unit: request.unit,
          });
        }
      } catch (err) {
        // The commonest cause is the module's own refusal to guess a mass
        // basis. That refusal is correct; reporting it is this code's job.
        decrements.unapplied.push({
          component: bind.component,
          item_ulid: bind.item_ulid,
          quantity,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return decrements;
  }

  /**
   * Turn a packed sheet's component bindings into concrete conversion sources,
   * merged with the explicit ones (§ A packed batch's sources follow the
   * submitted weights).
   *
   * Resolved BEFORE the conversion is planned, not applied after it, so the
   * decrements and the derived item stay one transaction. That is the whole
   * difference from `eaten`, where depletion follows an already-authoritative
   * entry and is allowed to fail loudly instead.
   *
   * **A binding beats an explicit source for the same item.** Naming an item
   * both ways is an authoring mistake with a right answer — the measured
   * quantity — and applying both would decrement twice while looking correct,
   * which is the exact failure mode this change exists to remove.
   */
  private resolvePackedSources(request: WorksheetCookRequest): {
    sources: { item_ulid: string; amount?: number; amount_g?: number }[];
    /** The bound decrements, in the outcome's shape — what the conversion will move. */
    applied: WorksheetCookDecrements['applied'];
  } {
    const packed = request.packed ?? {};
    // A per-unit sheet states ONE unit's build and yields `units` of them, so
    // the batch consumes that much times over. `batch` (the default) already
    // describes the whole thing.
    const multiplier =
      packed.components_per === 'unit' && packed.units && packed.units > 0 ? packed.units : 1;

    const quantities = new Map<string, number>(
      request.components.map((c) => [c.label, c.quantity] as [string, number])
    );

    const bound = new Map<string, { item_ulid: string; amount?: number; amount_g?: number }>();
    const applied: WorksheetCookDecrements['applied'] = [];
    for (const bind of request.consumes ?? []) {
      const quantity = quantities.get(bind.component);
      // A binding with no submitted quantity is silently skipped rather than
      // guessed at: the published amount is exactly the stale number this
      // resolution exists to stop trusting.
      if (quantity === undefined || quantity <= 0) continue;
      const total = quantity * multiplier;
      if (bind.model === 'counted') {
        // Whole units only — a fractional unit is not a thing you can spend
        // off a counted item, and rounding one would invent stock movement.
        const units = Math.round(total);
        bound.set(bind.item_ulid, { item_ulid: bind.item_ulid, amount: units });
        applied.push({ component: bind.component, item_ulid: bind.item_ulid, quantity: units, unit: 'unit' });
      } else {
        bound.set(bind.item_ulid, { item_ulid: bind.item_ulid, amount_g: total });
        applied.push({ component: bind.component, item_ulid: bind.item_ulid, quantity: total, unit: request.unit });
      }
    }

    const explicit = (packed.sources ?? []).filter((s) => !bound.has(s.item_ulid));
    return { sources: [...bound.values(), ...explicit], applied };
  }

  /**
   * A packed batch is a CONVERSION: sources decremented, one derived item
   * created carrying the recipe that fixes its macros, and NOTHING posted to the
   * journal. The batch is logged when it is eaten, at whatever share is actually
   * eaten then.
   *
   * The worksheet's submission ULID becomes the derived item's ULID, which is
   * what makes the conversion idempotent (§ Conversions § Retries).
   */
  private async recordPacked(request: WorksheetCookRequest): Promise<WorksheetCookOutcome> {
    const packed = request.packed ?? {};
    if (packed.shelf_life_class !== undefined && !isShelfLifeClass(packed.shelf_life_class)) {
      throw new CookModeValidationError(
        `cook mode shelf_life_class must be one of: ${SHELF_LIFE_CLASSES.join(', ')}`
      );
    }
    // Validated here so a nonsense field key fails the same way it would on an
    // eaten sheet, even though a conversion stores no macros itself.
    totalsToStatedMacros(request.totals);

    const { sources, applied } = this.resolvePackedSources(request);

    const { derived, created } = await this.config.inventory.convert({
      ...(sources.length > 0 ? { sources } : {}),
      derived: {
        ulid: request.ulid,
        name: request.label.trim(),
        ...(packed.shelf_life_class !== undefined
          ? { shelf_life_class: packed.shelf_life_class as ShelfLifeClass }
          : {}),
        ...(packed.units !== undefined ? { units_total: packed.units } : {}),
        ...(packed.recipe_ulid !== undefined ? { recipe_ulid: packed.recipe_ulid } : {}),
        notes: measuredNote(request),
        ...(request.at ? { acquired_at: request.at } : {}),
      },
      ...(request.at ? { at: request.at } : {}),
    });
    // The conversion is one transaction (§ Conversions § Atomicity): on a
    // fresh write every bound source moved, so the applied list is exactly
    // what was resolved. A replay moved nothing and reports nothing.
    return created
      ? { kind: 'item', ulid: derived.ulid, created, decrements: { applied, unapplied: [] } }
      : { kind: 'item', ulid: derived.ulid, created };
  }
}

/** `yogurt (01J…): net_content_g is required` — the entry-note / queue text. */
function describeUnapplied(d: WorksheetCookDecrements['unapplied'][number]): string {
  return d.item_ulid ? `${d.component} (${d.item_ulid}): ${d.reason}` : `${d.component}: ${d.reason}`;
}

/**
 * A replayed key must be asking for the write it already got. Compares the
 * stored entry's panel with the stated one field by field; a stub record that
 * carries no panel fields is not compared (nothing to compare against).
 */
function assertSamePanel(
  record: { ulid: string } & Partial<NutritionFields>,
  stated: StatedMacros,
  key: string
): void {
  const differing: string[] = [];
  for (const field of NUTRITION_FIELD_KEYS) {
    const stored = record[field];
    if (stored === undefined) continue;
    const asked = stated[field] ?? null;
    if (stored !== asked) differing.push(`${field}: recorded ${stored ?? 'unknown'}, submitted ${asked ?? 'unknown'}`);
  }
  if (differing.length === 0) return;
  throw new WorksheetCookConflictError(
    `submission key ${key} already recorded an entry with a different panel (${differing.join('; ')}). ` +
      'Each submission needs its own key: submit again to record these numbers as a new entry, ' +
      'or republish the sheet if this keeps happening.'
  );
}

function isShelfLifeClass(value: string): value is ShelfLifeClass {
  return (SHELF_LIFE_CLASSES as readonly string[]).includes(value);
}
