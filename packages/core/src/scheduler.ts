import { Cron } from 'croner';
import type { FastifyInstance } from 'fastify';
import { withAdvisoryLock } from './locks.js';

export interface ScheduledTask {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  runOnStartup?: boolean;
  /**
   * IANA timezone the cron expression is evaluated in (e.g. 'America/New_York').
   * Omit to use the server's local time (UTC in production).
   */
  timezone?: string;
  /**
   * Opt out of the advisory lock that otherwise serializes every run of this
   * task (see `specs/behaviors/scheduled-work-leases.md`). Only for handlers
   * that are provably idempotent *and* need to overlap with themselves — state
   * the reason at the call site. Defaults to false; leave it that way.
   */
  unlocked?: boolean;
}

export interface Scheduler {
  register(task: ScheduledTask): void;
  list(): Array<{ name: string; schedule: string; nextRun: Date | null }>;
  trigger(name: string): Promise<void>;
  stop(): void;
}

/** Lock name for a task — namespaced so it can't collide with another subsystem's. */
function lockName(task: string): string {
  return `scheduler:${task}`;
}

export function createScheduler(fastify: FastifyInstance): Scheduler {
  const tasks = new Map<string, { task: ScheduledTask; job: Cron }>();

  /**
   * Run a task's handler under its advisory lock.
   *
   * Skipping — rather than queueing behind the holder — is deliberate: a
   * minute-cadence sweep that waits for a slow predecessor accumulates pending
   * runs and held connections without bound, and the work is still there for
   * the next tick either way.
   */
  const runLocked = async (task: ScheduledTask): Promise<boolean> => {
    if (task.unlocked || !fastify.sql) {
      await task.handler();
      return true;
    }
    const result = await withAdvisoryLock(fastify.sql, lockName(task.name), task.handler);
    if (!result.acquired) {
      fastify.log.info({ task: task.name }, `Skipped ${task.name}: already running`);
    }
    return result.acquired;
  };

  return {
    register(task: ScheduledTask) {
      const runner = async () => {
        fastify.log.info(`Running scheduled task: ${task.name}`);
        try {
          const ran = await runLocked(task);
          if (ran) fastify.log.info(`Completed scheduled task: ${task.name}`);
        } catch (error) {
          fastify.log.error({ error, task: task.name }, `Failed scheduled task: ${task.name}`);
        }
      };
      const job = task.timezone
        ? new Cron(task.schedule, { timezone: task.timezone }, runner)
        : new Cron(task.schedule, runner);

      tasks.set(task.name, { task, job });
      fastify.log.info(`Registered scheduled task: ${task.name} (${task.schedule})`);

      if (task.runOnStartup) {
        fastify.log.info(`Running ${task.name} on startup`);
        runLocked(task).catch((error) => {
          fastify.log.error({ error, task: task.name }, `Startup run failed: ${task.name}`);
        });
      }
    },

    list() {
      return Array.from(tasks.values()).map(({ task, job }) => ({
        name: task.name,
        schedule: task.schedule,
        nextRun: job.nextRun(),
      }));
    },

    async trigger(name: string) {
      const entry = tasks.get(name);
      if (!entry) {
        throw new Error(`Task not found: ${name}`);
      }
      fastify.log.info(`Manually triggering task: ${name}`);
      // Deliberately the same lock as a scheduled run: a trigger that could
      // bypass it would be a supported way to double-process.
      await runLocked(entry.task);
    },

    stop() {
      for (const { job, task } of tasks.values()) {
        job.stop();
        fastify.log.info(`Stopped scheduled task: ${task.name}`);
      }
      tasks.clear();
    },
  };
}
