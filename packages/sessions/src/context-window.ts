/**
 * Context-window sizes per model, for turning a raw token reading into a
 * percentage. See specs/behaviors/session-context-window.md.
 *
 * Cached from published limits — the 1M window arrived with the 4.6
 * generation, the 4.5 generation is 200K. An unrecognised model resolves to
 * null so the UI shows figures without a percentage; a guessed denominator
 * would render as a bar the reader cannot tell apart from a measured one.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
};

/** Strips a trailing date snapshot: claude-opus-4-5-20251101 → claude-opus-4-5 */
const stripDateSuffix = (model: string) => model.replace(/-\d{8}$/, '');

/**
 * Context window for a model id, or null when the model is unknown.
 * Claude Code's `<synthetic>` placeholder is deliberately unknown — it marks
 * messages that never went to an API and so have no window.
 */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  return CONTEXT_WINDOWS[stripDateSuffix(model)] ?? null;
}
