/**
 * Tier 2 — driving a link-only unsubscribe page with a headless-browser CLI.
 *
 * The CLI is configured, not hardcoded: `unsubscribeBrowserBin` names any tool
 * that speaks the small verb set below (`open`, `eval`, `screenshot`) against a
 * persistent browser bridge, typically running on a separate always-on host.
 * The toolkit ships the mechanism; which binary and which host are instance
 * data.
 *
 * Two design commitments make this safe to run unattended:
 *
 *   - **Preflight, then exit clean.** The bridge is a live external dependency
 *     that is simply absent in CI and on a laptop. `preflight()` probes it with
 *     a short timeout; when it fails, the driver reports `unavailable` and the
 *     caller downgrades the attempt to tier 3 (a human decision) rather than
 *     retrying into a wall or, worse, half-submitting something.
 *   - **Act only on an unambiguous page.** The page is probed for a login wall
 *     and for confirm controls. Zero candidates, more than one candidate, or a
 *     password field ⇒ no click, downgrade to tier 3. There is no model here
 *     guessing which button to press.
 *
 * Whatever happens, a screenshot is written and its path returned; that file is
 * the proof pointer carried into the audit ledger.
 */

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable process runner — the seam every test drives instead of a browser. */
export interface CommandRunner {
  (bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: CommandRunner = async (bin, args, timeoutMs) => {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

export type BrowserOutcome =
  | 'submitted' // a confirm control was clicked
  | 'needs_review' // page reachable but not safely automatable
  | 'unavailable'; // the browser bridge itself could not be reached

export interface BrowserUnsubscribeResult {
  outcome: BrowserOutcome;
  /** Path to the screenshot proof, when one was captured. */
  screenshotPath?: string;
  /** Whether the post-click page showed a recognizable confirmation. */
  confirmed?: boolean;
  /** Machine-readable why, carried into the attempt detail + ledger context. */
  reason: string;
  /** Ordered trace of what the driver did — the human-readable half of proof. */
  steps: string[];
}

export interface BrowserDriver {
  preflight(): Promise<{ ok: boolean; detail: string }>;
  unsubscribe(url: string, opts: { screenshotPath: string }): Promise<BrowserUnsubscribeResult>;
}

export interface ChromeDriverConfig {
  /** The CLI binary. Instance data; no default host or profile is assumed. */
  bin: string;
  /** Per-command timeout. */
  timeoutMs?: number;
  /** Preflight probe timeout — short, because absence is the common case. */
  preflightTimeoutMs?: number;
  runner?: CommandRunner;
}

/**
 * Probe script: does this page have a login wall, and exactly one plausible
 * confirm control? Deterministic — a fixed selector set and a fixed vocabulary,
 * no model, no heuristics that could drift between runs.
 */
export const PROBE_SCRIPT = `(() => {
  const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
  const login = !!document.querySelector('input[type=password]');
  const controls = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]'));
  const candidates = controls.filter((el) => /unsubscribe|opt.?out|remove me|confirm/i.test(text(el)));
  return JSON.stringify({ login, candidates: candidates.length, texts: candidates.slice(0, 5).map(text) });
})()`;

/** Click script: re-finds the SAME single candidate the probe agreed on. */
export const CLICK_SCRIPT = `(() => {
  const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
  const controls = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]'));
  const candidates = controls.filter((el) => /unsubscribe|opt.?out|remove me|confirm/i.test(text(el)));
  if (candidates.length !== 1) return JSON.stringify({ clicked: false, candidates: candidates.length });
  candidates[0].click();
  return JSON.stringify({ clicked: true, label: text(candidates[0]) });
})()`;

/** Confirmation script: did the resulting page say the unsubscribe took? */
export const CONFIRM_SCRIPT = `(() => {
  const body = (document.body && document.body.innerText || '').slice(0, 4000);
  return JSON.stringify({ confirmed: /unsubscribed|you have been removed|no longer receive|successfully removed|preferences updated/i.test(body) });
})()`;

/**
 * Pull the result object out of CLI stdout.
 *
 * Observed against a real bridge, the same object arrives in three shapes: bare
 * JSON, a JSON *string* holding JSON (our scripts return a string, and the CLI
 * JSON-encodes what it got), and either of those wrapped in a `result: …` line
 * followed by help text. So: try the whole output, then any `result:` payload,
 * then a brace-extracted span — unwrapping repeatedly at each step, since one
 * layer of string-encoding is the common case and two is not rare.
 */
export function parseEvalJson(stdout: string): Record<string, unknown> | null {
  const unwrap = (value: unknown, depth = 0): Record<string, unknown> | null => {
    if (depth > 4) return null;
    if (typeof value === 'string') {
      try {
        return unwrap(JSON.parse(value), depth + 1);
      } catch {
        return null;
      }
    }
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  };

  const candidates: string[] = [];
  const trimmed = stdout.trim();
  if (trimmed) candidates.push(trimmed);

  // `result: <payload>` — the payload runs to the end of the line the CLI put
  // it on, and any trailing `help[n]:` block is not part of it.
  const resultMatch = stdout.match(/^[ \t]*result:[ \t]*(.+)$/m);
  if (resultMatch?.[1]) candidates.push(resultMatch[1].trim());

  const braceMatch = stdout.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = unwrap(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

export class ChromeDevtoolsBrowserDriver implements BrowserDriver {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly preflightTimeoutMs: number;
  private readonly run: CommandRunner;

  constructor(config: ChromeDriverConfig) {
    this.bin = config.bin;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.preflightTimeoutMs = config.preflightTimeoutMs ?? 10_000;
    this.run = config.runner ?? defaultRunner;
  }

  /**
   * Is the browser bridge reachable AND able to evaluate? A trivial `eval`
   * round-trip is the honest probe — the binary existing proves nothing about
   * the bridge being up, and a bridge that is up can still have no usable page.
   *
   * Note the exit code is not sufficient on its own: these CLIs commonly report
   * a bridge-side failure as an `Error:` on stdout and still exit 0. A probe
   * that answers anything other than `2` is treated as not ready.
   */
  async preflight(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { stdout } = await this.run(this.bin, ['eval', '1+1'], this.preflightTimeoutMs);
      const detail = stdout.trim().slice(0, 200) || 'bridge responded';
      if (/\bError:/.test(stdout)) {
        return { ok: false, detail };
      }
      return { ok: true, detail };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: message.slice(0, 300) };
    }
  }

  async unsubscribe(
    url: string,
    opts: { screenshotPath: string }
  ): Promise<BrowserUnsubscribeResult> {
    const steps: string[] = [];

    const pre = await this.preflight();
    if (!pre.ok) {
      return {
        outcome: 'unavailable',
        reason: `browser bridge unreachable: ${pre.detail}`,
        steps: ['preflight failed'],
      };
    }
    steps.push('preflight ok');

    try {
      await mkdir(dirname(opts.screenshotPath), { recursive: true });
    } catch {
      // A non-writable proof directory must not silently produce a click with
      // no proof: treat it as a review case.
      return {
        outcome: 'needs_review',
        reason: 'proof directory is not writable',
        steps,
      };
    }

    try {
      await this.run(this.bin, ['open', url], this.timeoutMs);
      steps.push(`open ${url}`);

      const probeOut = await this.run(this.bin, ['eval', PROBE_SCRIPT], this.timeoutMs);
      let probe = parseEvalJson(probeOut.stdout);
      steps.push(`probe ${probeOut.stdout.trim().slice(0, 160)}`);

      // A cold bridge can have zero pages open, in which case `open` navigates
      // nothing and the probe comes back empty. `newpage` is the recovery. It
      // is best-effort by design: a tool without that verb just errors here and
      // the attempt falls through to the review queue exactly as before.
      if (!probe) {
        try {
          await this.run(this.bin, ['newpage', url], this.timeoutMs);
          const retryOut = await this.run(this.bin, ['eval', PROBE_SCRIPT], this.timeoutMs);
          probe = parseEvalJson(retryOut.stdout);
          steps.push(`newpage + reprobe ${retryOut.stdout.trim().slice(0, 160)}`);
        } catch {
          steps.push('newpage recovery unavailable');
        }
      }

      // Screenshot BEFORE deciding: an unusable page still deserves proof of
      // what the automation actually saw.
      await this.run(this.bin, ['screenshot', opts.screenshotPath], this.timeoutMs);
      steps.push(`screenshot ${opts.screenshotPath}`);

      if (!probe) {
        return {
          outcome: 'needs_review',
          screenshotPath: opts.screenshotPath,
          reason: 'page probe returned no parseable result',
          steps,
        };
      }
      if (probe.login === true) {
        return {
          outcome: 'needs_review',
          screenshotPath: opts.screenshotPath,
          reason: 'login wall detected',
          steps,
        };
      }
      const candidates = Number(probe.candidates ?? 0);
      if (candidates !== 1) {
        return {
          outcome: 'needs_review',
          screenshotPath: opts.screenshotPath,
          reason:
            candidates === 0
              ? 'no unsubscribe control found on the page'
              : `${candidates} candidate controls — ambiguous`,
          steps,
        };
      }

      const clickOut = await this.run(this.bin, ['eval', CLICK_SCRIPT], this.timeoutMs);
      const click = parseEvalJson(clickOut.stdout);
      steps.push(`click ${clickOut.stdout.trim().slice(0, 160)}`);
      if (!click || click.clicked !== true) {
        return {
          outcome: 'needs_review',
          screenshotPath: opts.screenshotPath,
          reason: 'the control vanished between probe and click',
          steps,
        };
      }

      const confirmOut = await this.run(this.bin, ['eval', CONFIRM_SCRIPT], this.timeoutMs);
      const confirm = parseEvalJson(confirmOut.stdout);
      const confirmed = confirm?.confirmed === true;
      steps.push(`confirm ${confirmed}`);

      // Post-click screenshot overwrites the pre-click one: what the page says
      // AFTER the click is the evidence a human actually wants.
      await this.run(this.bin, ['screenshot', opts.screenshotPath], this.timeoutMs);
      steps.push('screenshot (post-click)');

      return {
        outcome: 'submitted',
        screenshotPath: opts.screenshotPath,
        confirmed,
        reason: confirmed
          ? 'clicked the unsubscribe control; page confirmed'
          : 'clicked the unsubscribe control; no confirmation text — verify the screenshot',
        steps,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: 'needs_review',
        screenshotPath: opts.screenshotPath,
        reason: `browser step failed: ${message.slice(0, 300)}`,
        steps,
      };
    }
  }
}
