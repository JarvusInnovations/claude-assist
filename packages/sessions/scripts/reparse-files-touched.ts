#!/usr/bin/env bun
/**
 * One-time migration script to reparse files_touched for all existing sessions.
 * Re-extracts file operations from raw_transcript to properly classify reads vs writes.
 *
 * Usage: bun packages/sessions/scripts/reparse-files-touched.ts
 *
 * Requires DATABASE_URL environment variable.
 */

import postgres from 'postgres';
import { parseTranscript } from '../src/parser.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

async function main() {
  console.log('Fetching sessions with raw transcripts...');

  const sessions = await sql<{ id: string; raw_transcript: string }[]>`
    SELECT id, raw_transcript
    FROM sessions.sessions
    WHERE raw_transcript IS NOT NULL AND raw_transcript != ''
  `;

  console.log(`Found ${sessions.length} sessions to reparse`);

  let updated = 0;
  let errors = 0;

  for (const session of sessions) {
    try {
      const parsed = parseTranscript(session.id, session.raw_transcript);

      await sql`
        UPDATE sessions.sessions
        SET files_touched = ${sql.json(parsed.filesTouched as any)}
        WHERE id = ${session.id}::uuid
      `;

      updated++;
      if (updated % 100 === 0) {
        console.log(`Progress: ${updated}/${sessions.length}`);
      }
    } catch (err) {
      errors++;
      console.error(`Error reparsing session ${session.id}:`, err);
    }
  }

  console.log(`\nDone! Updated: ${updated}, Errors: ${errors}`);
  await sql.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
