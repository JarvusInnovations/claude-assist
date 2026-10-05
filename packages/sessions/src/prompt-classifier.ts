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
  /** An origin kind other than `human` that has no rule of its own. */
  | 'origin'
  /** A scheduled wakeup: no origin, queue priority `later`. */
  | 'scheduled'
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
  /** `origin.kind` as the transcript recorded it; null on older clients. */
  originKind?: string | null;
  /** `queuePriority`; `later` marks a scheduled wakeup. */
  queuePriority?: string | null;
}

/** Origin kinds with a rule of their own; any other non-human kind is `origin`. */
const ORIGIN_RULES: Readonly<Record<string, AutomatedRule>> = {
  'task-notification': 'task-notification',
  peer: 'peer',
};

/**
 * Prefixes the client itself writes into user turns nobody typed — the
 * fallback for transcripts that carry no authorship fields. Only
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
  // Output of a `!` shell command; the `<bash-input>` turn is the person.
  ['<bash-stdout', 'local-command'],
  ['<bash-stderr', 'local-command'],
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

  // The transcript's own authorship claim decides before any text does: a
  // typed slash command (even `/loop`) is human; anything else with an
  // origin is not. Absent on older client versions.
  if (facts.originKind) {
    if (facts.originKind === 'human') return null;
    return ORIGIN_RULES[facts.originKind] ?? 'origin';
  }
  if (facts.queuePriority === 'later') return 'scheduled';

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
