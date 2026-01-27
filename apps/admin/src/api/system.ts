import { api } from "./client";
import type { ScheduledTask, HealthStatus } from "@/types/api";

export const systemApi = {
  // Health
  getHealth: () => api.get<HealthStatus>("/health"),

  // Scheduler
  getTasks: () => api.get<ScheduledTask[]>("/scheduler/tasks"),

  triggerTask: (name: string) => api.post(`/scheduler/tasks/${name}`),
};
