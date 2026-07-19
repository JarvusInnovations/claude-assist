/**
 * Splice the generated regions (command reference, etc.) into each
 * hand-authored SKILL.md. The narrative guidance outside the
 * `<!-- BEGIN/END GENERATED: <id> -->` markers is never touched.
 *
 *   bun scripts/build-skill.ts            # rewrite each SKILL.md
 *   bun scripts/build-skill.ts --check    # fail if any SKILL.md is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spliceGeneratedRegions as spliceSessions } from "../packages/sessions/src/axi/skill.ts";
import { spliceGmail, spliceGoogle } from "../packages/google/src/axi/skill.ts";
import { spliceGeneratedRegions as spliceKitchen } from "../packages/kitchen/src/axi/skill.ts";

interface SkillTarget {
  path: string;
  splice: (doc: string) => string;
}

const TARGETS: SkillTarget[] = [
  { path: "skills/assist-sessions/SKILL.md", splice: spliceSessions },
  { path: "skills/assist-gmail/SKILL.md", splice: spliceGmail },
  { path: "skills/assist-google-setup/SKILL.md", splice: spliceGoogle },
  { path: "skills/assist-kitchen/SKILL.md", splice: spliceKitchen },
];

const check = process.argv.includes("--check");
let stale = false;

for (const { path, splice } of TARGETS) {
  const src = readFileSync(path, "utf8");
  const out = splice(src);
  if (check) {
    if (src !== out) {
      console.error(`${path} is out of date — run \`bun run build:skill\` and commit the result`);
      stale = true;
    } else {
      console.log(`${path} is up to date`);
    }
  } else if (src !== out) {
    writeFileSync(path, out);
    console.log(`Updated ${path} generated regions`);
  } else {
    console.log(`${path} already up to date`);
  }
}

if (stale) process.exit(1);
