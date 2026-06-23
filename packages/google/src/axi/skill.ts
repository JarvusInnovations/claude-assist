import { COMMAND_GROUPS as GMAIL_GROUPS } from "./gmail/reference.js";
import { COMMAND_GROUPS as GOOGLE_GROUPS } from "./google/reference.js";
import type { CommandGroup } from "./gmail/reference.js";

/**
 * Generators for the machine-maintained command-reference regions of the two
 * Google skills' SKILL.md files. The narrative guidance is hand-authored and
 * lives outside the markers; these produce only the command reference, derived
 * from the same COMMAND_GROUPS the CLIs use — so the skills can never drift.
 *
 * Each CLI ships inside its skill and is invoked by its path relative to the
 * skill directory (`scripts/<name>-axi`), since it may be installed off PATH.
 */

function commandReferenceMarkdown(groups: CommandGroup[], invocation: string): string {
  return groups
    .map((group) => {
      const items = group.commands
        .map((c) => `- \`${invocation} ${c.usage}\` — ${c.summary}`)
        .join("\n");
      return `### ${group.group}\n\n${items}`;
    })
    .join("\n\n");
}

function makeSplicer(regions: Record<string, () => string>) {
  return (doc: string): string => {
    let out = doc;
    for (const [id, generate] of Object.entries(regions)) {
      const begin = `<!-- BEGIN GENERATED: ${id} -->`;
      const end = `<!-- END GENERATED: ${id} -->`;
      const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`);
      if (!pattern.test(out)) {
        throw new Error(`SKILL.md is missing the generated region markers for "${id}"`);
      }
      out = out.replace(pattern, `${begin}\n\n${generate().trim()}\n\n${end}`);
    }
    return out;
  };
}

export const spliceGmail = makeSplicer({
  "command-reference": () => commandReferenceMarkdown(GMAIL_GROUPS, "scripts/gmail-axi"),
});

export const spliceGoogle = makeSplicer({
  "command-reference": () => commandReferenceMarkdown(GOOGLE_GROUPS, "scripts/google-axi"),
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
