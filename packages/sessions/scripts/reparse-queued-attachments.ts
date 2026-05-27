#!/usr/bin/env bun
/**
 * One-time migration script to reparse user_messages for all existing sessions.
 *
 * Previously, parser.ts only treated `type: "user"` entries as user messages.
 * Claude Code persists prompts typed while the assistant is busy as
 * `type: "attachment"` with `attachment.type === "queued_command"`, which were
 * silently dropped from user_messages and the serialized transcript. This script
 * re-extracts user_messages from raw_transcript so historical sessions reflect
 * the corrected parsing.
 *
 * Updates: user_messages, user_message_count, message_count, search_text,
 * activity_ranges (new user timestamps shift the ranges).
 *
 * Usage: bun packages/sessions/scripts/reparse-queued-attachments.ts
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

  const sessions = await sql<{ id: string; raw_transcript: string; user_message_count: number }[]>`
    SELECT id, raw_transcript, user_message_count
    FROM sessions.sessions
    WHERE raw_transcript IS NOT NULL AND raw_transcript != ''
  `;

  console.log(`Found ${sessions.length} sessions to scan`);

  let updated = 0;
  let unchanged = 0;
  let recovered = 0;
  let errors = 0;

  for (const session of sessions) {
    try {
      const parsed = parseTranscript(session.id, session.raw_transcript);
      const newCount = parsed.userMessages.length;
      const oldCount = session.user_message_count;
      const delta = newCount - oldCount;

      if (delta === 0) {
        unchanged++;
        continue;
      }

      const searchText = parsed.userMessages.join(' ');

      await sql`
        UPDATE sessions.sessions SET
          user_messages = ${sql.json(parsed.userMessages)},
          user_message_count = ${newCount},
          message_count = ${parsed.messageCount},
          search_text = ${searchText},
          activity_ranges = ${sql.json(parsed.activityRanges as any)}
        WHERE id = ${session.id}::uuid
      `;

      updated++;
      recovered += delta;
      if (updated <= 20 || updated % 50 === 0) {
        console.log(`  ${session.id}: ${oldCount} → ${newCount} (+${delta})`);
      }
    } catch (err) {
      errors++;
      console.error(`Error reparsing session ${session.id}:`, err);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Sessions scanned:    ${sessions.length}`);
  console.log(`  Sessions updated:    ${updated}`);
  console.log(`  Sessions unchanged:  ${unchanged}`);
  console.log(`  Messages recovered:  ${recovered}`);
  console.log(`  Errors:              ${errors}`);
  await sql.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
