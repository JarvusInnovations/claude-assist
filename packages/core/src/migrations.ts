import type postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MigrationConfig {
  migrationsDir: string;
  schema?: string;
}

interface MigrationRecord {
  id: number;
  name: string;
  applied_at: Date;
}

/**
 * Validate that a string is a valid SQL identifier (schema name, table name, etc.)
 */
function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export async function runMigrations(
  sql: postgres.Sql,
  config: MigrationConfig
): Promise<string[]> {
  const { migrationsDir, schema = 'public' } = config;

  // Validate schema name to prevent SQL injection
  if (!isValidIdentifier(schema)) {
    throw new Error(
      `Invalid schema name: "${schema}". ` +
        'Must contain only letters, numbers, and underscores, and start with a letter or underscore.'
    );
  }

  // Ensure schema and migrations table exist
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Get already applied migrations
  const applied = await sql.unsafe<MigrationRecord[]>(
    `SELECT name FROM ${schema}.schema_migrations ORDER BY id`
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read migration files
  const files = await readdir(migrationsDir);
  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Alphabetical order: 001-foo.sql, 002-bar.sql

  const newMigrations: string[] = [];

  for (const file of sqlFiles) {
    if (appliedSet.has(file)) {
      continue;
    }

    const filePath = join(migrationsDir, file);
    const content = await readFile(filePath, 'utf-8');

    // Run migration in a transaction
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx.unsafe(
        `INSERT INTO ${schema}.schema_migrations (name) VALUES ($1)`,
        [file]
      );
    });

    newMigrations.push(file);
  }

  return newMigrations;
}

export async function getMigrationStatus(
  sql: postgres.Sql,
  config: MigrationConfig
): Promise<{ applied: string[]; pending: string[] }> {
  const { migrationsDir, schema = 'public' } = config;

  // Validate schema name to prevent SQL injection
  if (!isValidIdentifier(schema)) {
    throw new Error(
      `Invalid schema name: "${schema}". ` +
        'Must contain only letters, numbers, and underscores, and start with a letter or underscore.'
    );
  }

  // Check if migrations table exists
  const tableExists = await sql`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = ${schema}
      AND table_name = 'schema_migrations'
    )
  `;

  if (!tableExists[0]?.exists) {
    const files = await readdir(migrationsDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();
    return { applied: [], pending: sqlFiles };
  }

  const applied = await sql.unsafe<MigrationRecord[]>(
    `SELECT name FROM ${schema}.schema_migrations ORDER BY id`
  );
  const appliedNames = applied.map((r) => r.name);
  const appliedSet = new Set(appliedNames);

  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();
  const pending = sqlFiles.filter((f) => !appliedSet.has(f));

  return { applied: appliedNames, pending };
}
