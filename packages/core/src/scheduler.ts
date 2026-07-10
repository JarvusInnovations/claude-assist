import { Cron } from 'croner';
import type { FastifyInstance } from 'fastify';

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
}

export interface Scheduler {
  register(task: ScheduledTask): void;
  list(): Array<{ name: string; schedule: string; nextRun: Date | null }>;
  trigger(name: string): Promise<void>;
  stop(): void;
}

export function createScheduler(fastify: FastifyInstance): Scheduler {
  const tasks = new Map<string, { task: ScheduledTask; job: Cron }>();

  return {
    register(task: ScheduledTask) {
      const runner = async () => {
        fastify.log.info(`Running scheduled task: ${task.name}`);
        try {
          await task.handler();
          fastify.log.info(`Completed scheduled task: ${task.name}`);
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
        task.handler().catch((error) => {
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
      await entry.task.handler();
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
