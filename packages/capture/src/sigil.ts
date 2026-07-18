/**
 * Slack capture sigil.
 *
 * A direct-message to the assistant starting with `+ ` (plus, whitespace) is a capture, not
 * a conversation: it gets POSTed to /api/capture with source=slack instead
 * of spawning an agent session. `+` was chosen over `.c` because it reads
 * as "add this" and never collides with prose — the required whitespace
 * keeps `+1`, `+5 points`, etc. conversational.
 */

const SIGIL_PATTERN = /^\+\s+(\S[\s\S]*)$/;

/**
 * Returns the capture text (sigil stripped) when the message is a capture,
 * or null when it should flow to the normal chat agent.
 */
export function matchCaptureSigil(text: string): string | null {
  const match = text.trim().match(SIGIL_PATTERN);
  return match ? match[1]!.trim() : null;
}
