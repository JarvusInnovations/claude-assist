/**
 * Content-based ingest suppression.
 *
 * Some local tools spawn large volumes of tiny, automated Claude sessions — a
 * review-item triage runner, a batch linter, a cron that asks one question —
 * and they pollute the session archive. They look like legitimate sessions
 * (UUID-named transcripts above the minimum file size), so the subagent and
 * size filters don't catch them.
 *
 * We match on a stable string that the automation puts in its initiating
 * *prompt* (a user-role text message), checked against the parsed user
 * messages rather than the raw transcript. Matching parsed user messages is
 * crucial: the raw transcript of a legitimate session (e.g. one where someone
 * is debugging the triage runner) can quote the marker in tool output or
 * assistant prose, but the automation's marker only ever appears as an actual
 * user/prompt message in the sessions we want to suppress.
 */

/**
 * Markers suppressed by default: none.
 *
 * *Which* automation floods a given archive is instance data — one operator's
 * noisy runner is another operator's real work — so the toolkit ships the
 * mechanism and an empty list. Point `SESSIONS_IGNORE_MARKERS` at the stable
 * opening line of the automation's initiating prompt, e.g.
 *
 *   SESSIONS_IGNORE_MARKERS="You are triaging a review item."
 *
 * The constant stays exported rather than being inlined as `[]` so the seam
 * has a name and somewhere to document itself.
 */
export const DEFAULT_SESSION_IGNORE_MARKERS: readonly string[] = [];

/**
 * Returns true if any user message matches any ignore marker.
 *
 * @param userMessages Parsed user-role text messages (see parseTranscript).
 * @param markers Substrings to match; defaults to DEFAULT_SESSION_IGNORE_MARKERS.
 */
export function matchesIgnoreMarker(
  userMessages: readonly string[],
  markers: readonly string[] = DEFAULT_SESSION_IGNORE_MARKERS
): boolean {
  if (markers.length === 0 || userMessages.length === 0) {
    return false;
  }
  for (const message of userMessages) {
    for (const marker of markers) {
      if (marker && message.includes(marker)) {
        return true;
      }
    }
  }
  return false;
}
