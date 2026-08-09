/**
 * The deterministic extraction ruleset.
 *
 * An ordered list of rules is applied to each ingested session tool call; the
 * FIRST rule whose tool + target pattern matches wins, and NO match means the
 * call is not ledger-worthy (routine local work — edits, reads, plain shell —
 * is deliberately excluded; the transcript and git history already record it).
 *
 * The ruleset is versioned by a single `RULES_VERSION` string constant. Bumping
 * it re-derives the entire historical corpus (see derivation.ts), so improving
 * a rule retroactively improves the whole ledger — there is no emit-time capture
 * path that can silently break.
 *
 * Rules match agent-facing CLIs (invoked via the `Bash` tool) plus a few MCP
 * tool calls. Patterns are intentionally scoped to a single shell segment (they
 * stop at `|`, `&`, `;`, newline) so a compound command classifies on its first
 * ledger-worthy verb rather than bleeding across pipelines.
 *
 * **The built-in set covers tools any instance is likely to run.** An instance
 * that drives its own CLIs — a team knowledge system, an internal service —
 * adds rules through config (`LEDGER_EXTRA_RULES`) rather than by patching this
 * file; see `compileRules` and `EXAMPLE_EXTRA_RULES` below. Instance tooling is
 * instance data, and the toolkit ships the mechanism, not the roster.
 */

/**
 * Bump on any rule change; a mismatch with the stored version re-derives.
 *
 * Note the *configured* extra rules deliberately do not participate in this
 * version. An operator adding a rule bumps `LEDGER_RULES_VERSION_SUFFIX` (or
 * simply accepts that new calls classify going forward) — re-deriving the whole
 * corpus is a heavy operation to trigger from a config edit.
 */
export const RULES_VERSION = '2026-08-08.1';

/** A tool-call row as read from `sessions.tool_calls`. */
export interface ToolCallRow {
  id: number | string;
  session_id: string;
  msg_uuid: string;
  msg_index: number;
  ts: string | Date | null;
  tool_name: string;
  target: string | null;
  is_sidechain: boolean;
}

/** One extraction rule. */
export interface LedgerRule {
  /** Stable identifier — used in tests and debug logs, never user-facing. */
  name: string;
  /** Tool name to match. Exact unless `toolPrefix` is set. */
  tool: string;
  /** Treat `tool` as a prefix (e.g. an MCP namespace) instead of an exact name. */
  toolPrefix?: boolean;
  /** Regex over the tool call's `target` (the Bash command / MCP args). */
  pattern: RegExp;
  /**
   * If this also matches the target, the rule is skipped (e.g. a `--dry-run`
   * guard). Falling through means later rules still get a chance; if none match
   * the call is simply not ledger-worthy.
   */
  exclude?: RegExp;
  /** Broad action classification stored in `action_type`. */
  actionType: string;
  /** Target system stored in `target_system`. */
  targetSystem: string;
  /** Pull a stable target id out of the match groups / target, if any. */
  extractId?: (match: RegExpMatchArray, target: string) => string | null;
  /** One-line human summary. */
  summarize: (match: RegExpMatchArray, target: string) => string;
}

// Scoped to a single shell segment: any run of chars that are not a pipeline /
// list separator. Used between tokens so intervening flags/subcommands are
// tolerated without matching across `&&`, `;`, or `|`.
const SEG = String.raw`[^|&;\n]*?`;

/** Grab a PR / issue number from a `#42` or bare-number argument, if present. */
function extractNumber(_match: RegExpMatchArray, target: string): string | null {
  const m = target.match(/#(\d+)|(?:^|\s)(\d{1,7})(?=\s|$)/);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * Ordered ruleset. First match wins. Order matters only where patterns could
 * overlap; the sets below are disjoint by CLI + subcommand, so ordering is for
 * readability.
 */
export const RULES: LedgerRule[] = [
  // ── Repo writes: GitHub via gh / gh-axi ──────────────────────────────────
  {
    name: 'gh.pr',
    tool: 'Bash',
    pattern: new RegExp(String.raw`\bgh(?:-axi)?\b${SEG}\bpr\s+(create|merge|comment|edit|close|ready)\b`),
    actionType: 'repo-write',
    targetSystem: 'github',
    extractId: extractNumber,
    summarize: (m) => `GitHub PR ${m[1] ?? 'write'}`,
  },
  {
    name: 'gh.issue',
    tool: 'Bash',
    pattern: new RegExp(String.raw`\bgh(?:-axi)?\b${SEG}\bissue\s+(create|comment|edit|close)\b`),
    actionType: 'repo-write',
    targetSystem: 'github',
    extractId: extractNumber,
    summarize: (m) => `GitHub issue ${m[1] ?? 'write'}`,
  },
  {
    name: 'gh.release',
    tool: 'Bash',
    pattern: new RegExp(String.raw`\bgh(?:-axi)?\b${SEG}\brelease\s+(create|edit|delete|upload)\b`),
    actionType: 'repo-write',
    targetSystem: 'github',
    summarize: (m) => `GitHub release ${m[1] ?? 'write'}`,
  },

  // ── Repo writes: git push to a shared branch (dry-runs excluded) ─────────
  {
    name: 'git.push',
    tool: 'Bash',
    pattern: /\bgit\s+push\b/,
    exclude: /(?:^|\s)(?:--dry-run|-n)(?=\s|$)/,
    actionType: 'repo-write',
    targetSystem: 'git',
    extractId: (_m, target) => {
      // `git push [flags] <remote> <refspec>` — capture the remote if named.
      const m = target.match(/\bgit\s+push\b(?:\s+-\S+)*\s+([^\s-]\S*)/);
      return m ? (m[1] ?? null) : null;
    },
    summarize: () => 'git push',
  },

  // ── Outbound: Google Workspace (email / calendar / documents) ────────────
  {
    name: 'gws.gmail.send',
    tool: 'Bash',
    pattern: new RegExp(String.raw`\bgws-axi\b${SEG}\bgmail\b${SEG}\b(send|reply|forward)\b`),
    actionType: 'outbound',
    targetSystem: 'email',
    summarize: (m) => `Email ${m[1] ?? 'send'}`,
  },
  {
    name: 'gws.calendar.write',
    tool: 'Bash',
    pattern: new RegExp(String.raw`\bgws-axi\b${SEG}\bcalendar\b${SEG}\b(create|update|delete|invite)\b`),
    actionType: 'outbound',
    targetSystem: 'calendar',
    summarize: (m) => `Calendar ${m[1] ?? 'write'}`,
  },
  {
    name: 'gws.docs.create',
    tool: 'Bash',
    pattern: new RegExp(String.raw`\bgws-axi\b${SEG}\bdocs\b${SEG}\b(create|append|insert)\b`),
    actionType: 'outbound',
    targetSystem: 'document',
    summarize: (m) => `Document ${m[1] ?? 'create'}`,
  },

  // ── Outbound: Slack (messages others see) ────────────────────────────────
  {
    name: 'slack.post',
    tool: 'Bash',
    pattern: new RegExp(String.raw`\bslack-axi\b${SEG}\b(post|send|reply|dm)\b`),
    actionType: 'outbound',
    targetSystem: 'slack',
    summarize: (m) => `Slack ${m[1] ?? 'post'}`,
  },

  // ── Outbound: notifications sent from within a session (MCP tool) ────────
  {
    name: 'pushover.send',
    tool: 'mcp__pushover__send',
    // MCP tool calls carry their args (or nothing) in target; always match.
    pattern: /^/,
    actionType: 'outbound',
    targetSystem: 'notification',
    summarize: () => 'Pushover notification sent',
  },
];

/** The classification of a matched tool call. */
export interface Classification {
  rule: LedgerRule;
  match: RegExpMatchArray;
}

/**
 * Classify a single tool call. Returns the first matching rule (and its regex
 * match) or `null` when the call is not ledger-worthy.
 */
export function classifyToolCall(
  toolName: string,
  target: string,
  rules: LedgerRule[] = RULES,
): Classification | null {
  for (const rule of rules) {
    const nameOk = rule.toolPrefix ? toolName.startsWith(rule.tool) : toolName === rule.tool;
    if (!nameOk) continue;
    const match = target.match(rule.pattern);
    if (!match) continue;
    if (rule.exclude && rule.exclude.test(target)) continue;
    return { rule, match };
  }
  return null;
}

/** A derived action, ready to persist. `null` fields map to SQL NULL. */
export interface DerivedActionRecord {
  ts: string | Date | null;
  actor: {
    kind: 'session' | 'agent';
    session_id: string;
    sidechain: boolean;
  };
  actionType: string;
  targetSystem: string;
  targetId: string | null;
  summary: string;
  context: { tool_call_id: string; session_id: string; msg_uuid: string };
  rulesVersion: string;
}

/**
 * Derive a ledger action from a tool call, or `null` if the call is not
 * ledger-worthy. Sidechain calls are attributed to the `agent` actor kind (with
 * the session id + sidechain flag) so subagent-performed actions still land.
 */
export function deriveAction(
  tc: ToolCallRow,
  rules: LedgerRule[] = RULES,
  rulesVersion: string = RULES_VERSION,
): DerivedActionRecord | null {
  const target = tc.target ?? '';
  const classified = classifyToolCall(tc.tool_name, target, rules);
  if (!classified) return null;

  const { rule, match } = classified;
  return {
    ts: tc.ts,
    actor: {
      kind: tc.is_sidechain ? 'agent' : 'session',
      session_id: tc.session_id,
      sidechain: tc.is_sidechain,
    },
    actionType: rule.actionType,
    targetSystem: rule.targetSystem,
    targetId: rule.extractId ? rule.extractId(match, target) : null,
    summary: rule.summarize(match, target),
    context: {
      tool_call_id: String(tc.id),
      session_id: tc.session_id,
      msg_uuid: tc.msg_uuid,
    },
    rulesVersion,
  };
}


/**
 * A rule as an operator writes it in config — plain JSON, no functions.
 *
 * This is the seam that keeps an instance's own tooling out of a public
 * toolkit. `pattern` and `exclude` are regex *source* strings, applied
 * case-sensitively over the tool call's target.
 */
export interface LedgerRuleSpec {
  name: string;
  /** Tool name to match, e.g. `Bash` or an MCP tool name. */
  tool: string;
  toolPrefix?: boolean;
  /** Regex source. Use `SEGMENT` (see below) to span flags within one command. */
  pattern: string;
  exclude?: string;
  actionType: string;
  targetSystem: string;
  /**
   * Human summary. `$1`…`$9` interpolate the pattern's capture groups, so a
   * rule can name the verb it matched without shipping a function.
   */
  summary?: string;
}

/**
 * The single-shell-segment matcher, exported so a configured pattern can use
 * the same scoping the built-in rules do rather than re-deriving it.
 */
export const SEGMENT = SEG;

/** Substitute `$1`…`$9` from a match, leaving unmatched groups empty. */
function interpolate(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$([1-9])/g, (_, digit: string) => match[Number(digit)] ?? '');
}

/**
 * Compile operator-supplied rule specs into runnable rules.
 *
 * A malformed spec is skipped with a warning rather than failing boot: one bad
 * regex in a config blob must not take the instance down, and a missing rule is
 * visible as an under-populated ledger.
 */
export function compileRules(
  specs: LedgerRuleSpec[],
  onError?: (spec: LedgerRuleSpec, error: unknown) => void,
): LedgerRule[] {
  const compiled: LedgerRule[] = [];
  for (const spec of specs) {
    try {
      compiled.push({
        name: spec.name,
        tool: spec.tool,
        ...(spec.toolPrefix ? { toolPrefix: true } : {}),
        pattern: new RegExp(spec.pattern),
        ...(spec.exclude ? { exclude: new RegExp(spec.exclude) } : {}),
        actionType: spec.actionType,
        targetSystem: spec.targetSystem,
        summarize: (m) => (spec.summary ? interpolate(spec.summary, m) : spec.name),
      });
    } catch (error) {
      onError?.(spec, error);
    }
  }
  return compiled;
}

/**
 * A worked example for the docs and for operators to copy.
 *
 * It classifies writes made through an instance-specific team-knowledge CLI —
 * exactly the kind of rule that belongs in an instance's config and not in a
 * public toolkit. Replace the CLI name and verbs with your own.
 */
export const EXAMPLE_EXTRA_RULES: LedgerRuleSpec[] = [
  {
    name: 'team-cli.write',
    tool: 'Bash',
    pattern: String.raw`\bteam-cli\b${SEG}\b(log|create|update|commitment)\b`,
    actionType: 'team-record-write',
    targetSystem: 'team-records',
    summary: 'Team record $1',
  },
];
