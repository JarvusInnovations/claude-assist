/**
 * Content-based ingest suppression.
 *
 * Some local tools spawn large volumes of tiny, automated Claude sessions
 * (e.g. the M87 review-item triage runner) that pollute the session archive.
 * These look like legitimate sessions — UUID-named transcripts above the
 * minimum file size — so the subagent/size filters don't catch them.
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
 * Markers suppressed by default. A session is ignored if any of its user
 * messages contains one of these substrings.
 */
export const DEFAULT_SESSION_IGNORE_MARKERS: readonly string[] = [
  // M87 local-first review-item triage runner — floods history with tiny sessions
  'You are triaging a local-first M87 review item.',
];

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
