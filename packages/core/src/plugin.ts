import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type postgres from 'postgres';
import type { Scheduler } from './scheduler.js';

/**
 * Extended Fastify instance with claude-assist decorators
 */
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export interface PluginOptions {
  /** Name of the plugin for logging */
  name: string;
  /** Directory containing SQL migration files */
  migrationsDir?: string;
  /** Database schema to use (default: plugin name) */
  schema?: string;
}

export interface ModulePlugin {
  plugin: FastifyPluginAsync<PluginOptions>;
  options: PluginOptions;
}

/**
 * Create a module plugin that follows claude-assist conventions
 *
 * Provides:
 * - Automatic migration running on startup
 * - Access to sql client via fastify.sql
 * - Access to scheduler via fastify.scheduler
 */
export function createPlugin(
  name: string,
  setup: (
    fastify: FastifyInstance,
    options: PluginOptions
  ) => Promise<void>
): FastifyPluginAsync<Partial<PluginOptions>> {
  const plugin: FastifyPluginAsync<Partial<PluginOptions>> = async (
    fastify,
    opts
  ) => {
    const options: PluginOptions = {
      name,
      schema: opts.schema ?? name,
      migrationsDir: opts.migrationsDir,
    };

    fastify.log.info(`Loading plugin: ${name}`);

    // Run migrations if migrations directory is provided (unless disabled)
    if (options.migrationsDir && fastify.sql && process.env.DISABLE_MIGRATIONS !== 'true') {
      const { runMigrations } = await import('./migrations.js');
      const applied = await runMigrations(fastify.sql, {
        migrationsDir: options.migrationsDir,
        schema: options.schema,
      });

      if (applied.length > 0) {
        fastify.log.info(
          { migrations: applied },
          `Applied ${applied.length} migrations for ${name}`
        );
      }
    }

    // Run the plugin setup
    await setup(fastify, options);

    fastify.log.info(`Loaded plugin: ${name}`);
  };

  // Wrap with fastify-plugin to avoid encapsulation
  return fp(plugin, {
    name,
    fastify: '5.x',
    dependencies: [], // Add dependencies as needed
  });
}
