import { AxiError } from "axi-sdk-js";
import { api } from "../../client.js";
import { parseArgs, rawJson } from "../../args.js";
import { renderObject } from "../../toon.js";

export const EXECUTE_HELP = `gmail-axi execute <email-id>... [--no-labels] [--no-actions] [--json]

  Confirm-to-execute the staged triage plans for the given emails: apply the
  planned AI/* + TODO/* labels and any archive/spam move. Deterministic — no
  model call. Nothing is applied to Gmail until you run this.
    --no-labels   apply only the archive/spam move (skip label changes)
    --no-actions  apply only labels; leave the message where it is
  Spam moves the message to Gmail's Spam folder; it is never deleted.`;

export async function executeCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "no-labels", "no-actions"]);
  const ids = positionals.map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  if (ids.length === 0) {
    throw new AxiError("At least one email id is required", "VALIDATION_ERROR", [EXECUTE_HELP]);
  }
  const body: Record<string, unknown> = { email_ids: ids };
  if (flags["no-labels"]) body.apply_labels = false;
  if (flags["no-actions"]) body.apply_gmail_action = false;
  const result = await api.post("/api/google/emails/execute", body);
  if (flags.json) return rawJson(result);
  return renderObject(result ?? { requested: ids.length });
}

export const DIGEST_HELP = `gmail-axi digest [--json]

  Preview the daily confirm-to-execute digest: triaged-but-unexecuted email
  grouped by section, each with its planned action, plus the email-id list you
  would hand to \`gmail-axi execute\`. Read-only — dispatching the digest to
  Slack runs on its own schedule.`;

export async function digestCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const result = await api.get("/api/google/emails/digest");
  if (flags.json) return rawJson(result);
  return renderObject(result ?? {});
}
