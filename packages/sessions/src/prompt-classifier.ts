/**
 * Human-or-automated classification of prompt events
 * (specs/behaviors/session-engagement.md: "Human or automated"). A pure
 * function of the facts ingest recorded and the pattern lists — applied when
 * engagement is read, never stored, so a better marker list or a new instance
 * pattern corrects every past day with no re-ingest.
 */

export type AutomatedRule =
  | 'meta'
  | 'sidechain'
  | 'compaction'
  | 'loop'
  | 'task-notification'
  | 'local-command'
  | 'system'
  | 'interrupt'
  | 'peer'
  | 'instance';

export interface PromptFacts {
  /** Leading text as stored (front-trimmed, bounded). */
  head: string;
  isMeta: boolean;
  isSidechain: boolean;
  isCompactSummary: boolean;
}

/**
 * Prefixes the client itself writes into user turns nobody typed. Only
 * client-emitted wrappers belong here; anything naming a particular bot,
 * bridge or scheduled command is instance data and arrives through
 * `SESSIONS_AUTOMATED_PROMPT_PATTERNS`.
 */
const BUILT_IN_MARKERS: ReadonlyArray<readonly [prefix: string, rule: AutomatedRule]> = [
  ['<command-message>loop', 'loop'],
  ['<command-name>/loop', 'loop'],
  ['<<autonomous-loop', 'loop'],
  ['<task-notification', 'task-notification'],
  ['This session is being continued', 'compaction'],
  ['<local-command', 'local-command'],
  ['Caveat:', 'local-command'],
  ['<system-reminder', 'system'],
  ['[Request interrupted', 'interrupt'],
  // A message another agent session sent into this one.
  ['<cross-session-message', 'peer'],
];

/** `null` means human; otherwise the rule that marked the prompt automated. */
export function classifyPrompt(facts: PromptFacts, instancePatterns: readonly RegExp[] = []): AutomatedRule | null {
  if (facts.isMeta) return 'meta';
  if (facts.isSidechain) return 'sidechain';
  if (facts.isCompactSummary) return 'compaction';

  const head = facts.head.trimStart();
  for (const [prefix, rule] of BUILT_IN_MARKERS) {
    if (head.startsWith(prefix)) return rule;
  }
  for (const pattern of instancePatterns) {
    // A shared RegExp with the g or y flag carries lastIndex between calls.
    pattern.lastIndex = 0;
    if (pattern.test(head)) return 'instance';
  }
  return null;
}

/**
 * Compile `SESSIONS_AUTOMATED_PROMPT_PATTERNS` — newline-separated regular
 * expressions, blank lines ignored. Throws naming the offending pattern, so a
 * typo fails startup instead of silently counting automation as human time.
 */
export function compileAutomatedPromptPatterns(raw: string | undefined | null): RegExp[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((source) => {
      try {
        return new RegExp(source);
      } catch (err) {
        throw new Error(
          `SESSIONS_AUTOMATED_PROMPT_PATTERNS: invalid regular expression ${JSON.stringify(source)}: ${(err as Error).message}`
        );
      }
    });
}
