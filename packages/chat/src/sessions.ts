import type postgres from 'postgres';

export interface ThreadSession {
  threadId: string;
  sessionId: string;
  lastMessageAt: Date;
}

export class SessionStore {
  constructor(private sql: postgres.Sql) {}

  async getSessionId(threadId: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT session_id FROM chat.thread_sessions
      WHERE thread_id = ${threadId}
    `;
    return rows.length > 0 ? rows[0]!.session_id : null;
  }

  async upsert(threadId: string, sessionId: string): Promise<void> {
    await this.sql`
      INSERT INTO chat.thread_sessions (thread_id, session_id, last_message_at)
      VALUES (${threadId}, ${sessionId}, NOW())
      ON CONFLICT (thread_id)
      DO UPDATE SET session_id = ${sessionId}, last_message_at = NOW()
    `;
  }

}
