import { describe, expect, it } from 'bun:test';
import {
  RULES,
  RULES_VERSION,
  classifyToolCall,
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
    ['hq-axi.write', 'hq-axi log "wrapped up a thing"', 'team-record-write'],
    ['hq-axi.write', 'hq-axi project create --name Widget', 'team-record-write'],
    ['hq-axi.write', 'hq-axi commitment resolve 7', 'team-record-write'],
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
    'hq-axi search widgets',   // read-only query, not a write verb
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
  it('classifies on the first ledger-worthy verb of a compound command', () => {
    // hq-axi appears before the gh push in the pipeline; hq wins.
    const c = classifyToolCall('Bash', 'hq-axi log "x" && gh pr merge 3');
    expect(c?.rule.name).toBe('hq-axi.write');
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
      target: 'hq-axi log "did a thing"',
      is_sidechain: false,
      ...overrides,
    };
  }

  it('builds a derived record with a session actor + context pointer', () => {
    const rec = deriveAction(tc({}))!;
    expect(rec.actionType).toBe('team-record-write');
    expect(rec.targetSystem).toBe('hq');
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
});
