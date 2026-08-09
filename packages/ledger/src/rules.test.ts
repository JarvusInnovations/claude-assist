import { describe, expect, it } from 'bun:test';
import {
  EXAMPLE_EXTRA_RULES,
  RULES,
  RULES_VERSION,
  classifyToolCall,
  compileRules,
  deriveAction,
  type ToolCallRow,
} from './rules.js';

// All command strings below are INVENTED generic examples — none are real
// commands from any transcript corpus. They exist only to exercise the regexes.

/** Classify a Bash command and return the matched rule name (or null). */
function ruleFor(command: string, tool = 'Bash'): string | null {
  const c = classifyToolCall(tool, command);
  return c ? c.rule.name : null;
}

describe('classifyToolCall — positive matches (one per seed rule)', () => {
  const cases: Array<[string, string, string]> = [
    ['gh.pr', 'gh pr merge 42 --method merge', 'repo-write'],
    ['gh.pr', 'gh-axi pr create --title Thing', 'repo-write'],
    ['gh.issue', 'gh issue comment 9 --body hi', 'repo-write'],
    ['gh.release', 'gh release create v1.2.3', 'repo-write'],
    ['git.push', 'git push origin my-branch', 'repo-write'],
    ['gws.gmail.send', 'gws-axi gmail send --to a@example.com --subject Hi', 'outbound'],
    ['gws.calendar.write', 'gws-axi calendar create --title Sync', 'outbound'],
    ['gws.docs.create', 'gws-axi docs create --title Notes', 'outbound'],
    ['slack.post', 'slack-axi post --channel general --text hello', 'outbound'],
  ];

  for (const [expectedRule, command, expectedType] of cases) {
    it(`${expectedRule}: matches \`${command}\``, () => {
      const c = classifyToolCall('Bash', command);
      expect(c?.rule.name).toBe(expectedRule);
      expect(c?.rule.actionType).toBe(expectedType);
    });
  }

  it('pushover.send: matches the MCP tool regardless of target', () => {
    const c = classifyToolCall('mcp__pushover__send', '{"title":"x","message":"y"}');
    expect(c?.rule.name).toBe('pushover.send');
    expect(c?.rule.targetSystem).toBe('notification');
    // Empty target still matches (MCP calls may carry args elsewhere).
    expect(classifyToolCall('mcp__pushover__send', '')?.rule.name).toBe('pushover.send');
  });
});

describe('classifyToolCall — negative (not ledger-worthy)', () => {
  const negatives = [
    'ls -la',
    'cat README.md',
    'git status',
    'git commit -m "local work"',
    'gh pr view 42',           // read-only, not a write verb
    'gh issue list',           // read-only
    'gws-axi gmail list',      // read-only
    'slack-axi search foo',    // read-only
    'echo "deploying with gh pr"', // no actual write subcommand
  ];
  for (const command of negatives) {
    it(`no match: \`${command}\``, () => {
      expect(ruleFor(command)).toBeNull();
    });
  }

  it('a non-pushover MCP tool is not matched by the pushover rule', () => {
    expect(classifyToolCall('mcp__tana__create_node', 'anything')).toBeNull();
  });
});

describe('git push dry-run guard', () => {
  it('excludes --dry-run', () => {
    expect(ruleFor('git push --dry-run origin main')).toBeNull();
  });
  it('excludes the -n shorthand', () => {
    expect(ruleFor('git push -n origin main')).toBeNull();
  });
  it('still matches a real push', () => {
    expect(ruleFor('git push origin main')).toBe('git.push');
  });
});

describe('classifyToolCall — first match wins + segment scoping', () => {
  it('resolves a compound command by RULE order, not by position in the string', () => {
    // Both segments are ledger-worthy. The winner is whichever rule comes first
    // in the ordered set — `gh.pr` here — regardless of which verb the operator
    // happened to type first. Worth pinning: it is the rule most likely to be
    // misremembered when someone adds a rule and wonders why it never fires.
    const c = classifyToolCall('Bash', 'slack-axi post --text x && gh pr merge 3');
    expect(c?.rule.name).toBe('gh.pr');
  });

  it('does not bleed a pattern across a pipe boundary', () => {
    // `gh` is only referenced past the pipe as an argument to grep — the git
    // push segment is what classifies.
    const c = classifyToolCall('Bash', 'git push origin main | grep gh');
    expect(c?.rule.name).toBe('git.push');
  });
});

describe('id extraction', () => {
  it('pulls a PR number from `gh pr merge`', () => {
    const c = classifyToolCall('Bash', 'gh pr merge 128 --method merge')!;
    expect(c.rule.extractId!(c.match, 'gh pr merge 128 --method merge')).toBe('128');
  });
  it('pulls the remote from `git push`', () => {
    const c = classifyToolCall('Bash', 'git push upstream topic')!;
    expect(c.rule.extractId!(c.match, 'git push upstream topic')).toBe('upstream');
  });
});

describe('deriveAction', () => {
  function tc(overrides: Partial<ToolCallRow>): ToolCallRow {
    return {
      id: 1,
      session_id: '00000000-0000-0000-0000-000000000001',
      msg_uuid: 'u-1',
      msg_index: 0,
      ts: '2026-07-12T10:00:00Z',
      tool_name: 'Bash',
      target: 'slack-axi post --channel general --text "did a thing"',
      is_sidechain: false,
      ...overrides,
    };
  }

  it('builds a derived record with a session actor + context pointer', () => {
    const rec = deriveAction(tc({}))!;
    expect(rec.actionType).toBe('outbound');
    expect(rec.targetSystem).toBe('slack');
    expect(rec.actor).toEqual({
      kind: 'session',
      session_id: '00000000-0000-0000-0000-000000000001',
      sidechain: false,
    });
    expect(rec.context.tool_call_id).toBe('1');
    expect(rec.context.msg_uuid).toBe('u-1');
    expect(rec.rulesVersion).toBe(RULES_VERSION);
  });

  it('attributes a sidechain call to the agent actor kind', () => {
    const rec = deriveAction(tc({ is_sidechain: true }))!;
    expect(rec.actor.kind).toBe('agent');
    expect(rec.actor.sidechain).toBe(true);
  });

  it('returns null for a non-ledger-worthy call', () => {
    expect(deriveAction(tc({ target: 'git status' }))).toBeNull();
  });

  it('tolerates a null target', () => {
    expect(deriveAction(tc({ target: null }))).toBeNull();
    // A pushover MCP call with null target still derives.
    const rec = deriveAction(tc({ tool_name: 'mcp__pushover__send', target: null }))!;
    expect(rec.targetSystem).toBe('notification');
  });
});

describe('RULES catalog', () => {
  it('has unique rule names', () => {
    const names = RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names no instance-specific CLI — private tooling arrives through config', () => {
    // The shipped set covers tools any instance is likely to run. Anything
    // narrower belongs in LEDGER_EXTRA_RULES, which is what keeps one
    // operator's tool roster out of a public toolkit.
    const shipped = new Set(RULES.map((r) => r.targetSystem));
    expect([...shipped].sort()).toEqual([
      'calendar',
      'document',
      'email',
      'git',
      'github',
      'notification',
      'slack',
    ]);
  });
});

describe('compileRules (the instance-config seam)', () => {
  it('compiles a spec into a rule that classifies and summarizes', () => {
    const rules = compileRules(EXAMPLE_EXTRA_RULES);
    const c = classifyToolCall('Bash', 'team-cli log "wrapped up a thing"', rules)!;

    expect(c.rule.name).toBe('team-cli.write');
    expect(c.rule.actionType).toBe('team-record-write');
    // `$1` interpolates the matched verb, so a config rule can name what it saw
    // without shipping a function.
    expect(c.rule.summarize(c.match, '')).toBe('Team record log');
  });

  it('runs configured rules AFTER the built-ins, refining rather than shadowing', () => {
    const shadowing = compileRules([
      {
        name: 'greedy',
        tool: 'Bash',
        pattern: '.',
        actionType: 'other',
        targetSystem: 'other',
      },
    ]);
    const c = classifyToolCall('Bash', 'git push origin main', [...RULES, ...shadowing]);
    expect(c?.rule.name).toBe('git.push');
  });

  it('honors an exclude pattern', () => {
    const rules = compileRules([
      {
        name: 'deploy',
        tool: 'Bash',
        pattern: String.raw`\bdeploy\b`,
        exclude: String.raw`--dry-run`,
        actionType: 'deploy',
        targetSystem: 'infra',
      },
    ]);
    expect(classifyToolCall('Bash', 'deploy prod', rules)?.rule.name).toBe('deploy');
    expect(classifyToolCall('Bash', 'deploy prod --dry-run', rules)).toBeNull();
  });

  it('skips a malformed spec with a callback instead of throwing', () => {
    // One bad regex in an operator's config must not take the instance down;
    // the cost is an under-populated ledger, which is visible and fixable.
    const errors: string[] = [];
    const rules = compileRules(
      [
        { name: 'bad', tool: 'Bash', pattern: '([', actionType: 'x', targetSystem: 'y' },
        { name: 'good', tool: 'Bash', pattern: 'ok', actionType: 'x', targetSystem: 'y' },
      ],
      (spec) => errors.push(spec.name),
    );
    expect(errors).toEqual(['bad']);
    expect(rules.map((r) => r.name)).toEqual(['good']);
  });
});
