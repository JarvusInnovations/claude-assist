/**
 * Error formatting shared by the bundled AXI CLIs.
 *
 * The SDK exits 2 only for `VALIDATION_ERROR`. The strict parser (`flags.ts`)
 * also raises `UNKNOWN_FLAG` and `USAGE`, which are the caller's mistake in the
 * same way and must exit 2 too (specs/behaviors/axi-cli-arguments-and-export.md).
 * The exit-code mapping is ported from nexudus-axi `src/cli.ts`; the rendering
 * is the SDK's own, so existing errors print exactly as before.
 */
import { AxiError, exitCodeForError } from "axi-sdk-js";
import { encode } from "@toon-format/toon";

/** Codes that mean "the invocation was wrong": exit 2. */
export const USAGE_CODES = new Set(["VALIDATION_ERROR", "UNKNOWN_FLAG", "USAGE"]);

function renderFailure(message: string, code: string, suggestions: string[] = []): string {
  return `${encode({ error: message, code, ...(suggestions.length > 0 ? { help: suggestions } : {}) })}\n`;
}

export function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    return {
      output: renderFailure(error.message, error.code, error.suggestions),
      exitCode: USAGE_CODES.has(error.code) ? 2 : exitCodeForError(error),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { output: renderFailure(message, "UNKNOWN"), exitCode: 1 };
}
