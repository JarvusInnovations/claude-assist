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
 * double-decrement.
 */

import type {
  WorksheetCookOutcome,
  WorksheetCookRequest,
  WorksheetCookSink,
} from '@jarvus/claude-assist-core';
import { NUTRITION_FIELD_KEYS, type StatedMacros } from '../types.js';
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
  ): Promise<{ record: { ulid: string }; created: boolean }>;
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

    // Decrements run AFTER the entry, and never roll it back
    // (§ The entry is authoritative). A meal that refused to record because a
    // bag lacked a net weight would be a strictly worse ledger than one that
    // records and flags the gap.
    if (created && request.consumes?.length) {
      const unapplied = await this.applyConsumes(request, record.ulid);
      if (unapplied.length > 0) {
        // Surfaced, never swallowed: an invisible skip would reproduce exactly
        // the drift this feature removes while looking fixed.
        await this.config.entries.flagUnappliedDecrements?.(record.ulid, unapplied);
      }
    }

    return { kind: 'entry', ulid: record.ulid, created };
  }

  /**
   * Apply each binding at its SUBMITTED quantity. Returns human-readable
   * descriptions of the ones that could not be applied.
   */
  private async applyConsumes(
    request: WorksheetCookRequest,
    entryUlid: string
  ): Promise<string[]> {
    const unapplied: string[] = [];
    const quantities = new Map<string, number>(
      request.components.map((c) => [c.label, c.quantity] as [string, number])
    );

    for (const bind of request.consumes ?? []) {
      const quantity = quantities.get(bind.component);
      if (quantity === undefined) {
        unapplied.push(`${bind.component}: no submitted quantity`);
        continue;
      }
      if (quantity <= 0) continue; // Nothing eaten, nothing to take off.
      if (!this.config.depleter) {
        unapplied.push(`${bind.component}: no depleter configured`);
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
        } else {
          await this.config.depleter.consumeStated(bind.item_ulid, {
            amount_g: quantity,
            entry_ulid: entryUlid,
            ...(request.at ? { at: request.at } : {}),
          });
        }
      } catch (err) {
        // The commonest cause is the module's own refusal to guess a mass
        // basis. That refusal is correct; reporting it is this code's job.
        unapplied.push(
          `${bind.component} (${bind.item_ulid}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return unapplied;
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
  private resolvePackedSources(
    request: WorksheetCookRequest
  ): { item_ulid: string; amount?: number; amount_g?: number }[] {
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
    for (const bind of request.consumes ?? []) {
      const quantity = quantities.get(bind.component);
      // A binding with no submitted quantity is silently skipped rather than
      // guessed at: the published amount is exactly the stale number this
      // resolution exists to stop trusting.
      if (quantity === undefined || quantity <= 0) continue;
      const total = quantity * multiplier;
      bound.set(
        bind.item_ulid,
        bind.model === 'counted'
          ? // Whole units only — a fractional unit is not a thing you can spend
            // off a counted item, and rounding one would invent stock movement.
            { item_ulid: bind.item_ulid, amount: Math.round(total) }
          : { item_ulid: bind.item_ulid, amount_g: total }
      );
    }

    const explicit = (packed.sources ?? []).filter((s) => !bound.has(s.item_ulid));
    return [...bound.values(), ...explicit];
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

    const sources = this.resolvePackedSources(request);

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
    return { kind: 'item', ulid: derived.ulid, created };
  }
}

function isShelfLifeClass(value: string): value is ShelfLifeClass {
  return (SHELF_LIFE_CLASSES as readonly string[]).includes(value);
}
