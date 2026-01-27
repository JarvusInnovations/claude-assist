import { api, apiRequest } from "./client";
import type {
  SessionRecord,
  SessionStats,
  SessionQueryParams,
  MachineRecord,
  OutlineProgress,
} from "@/types/api";

export const sessionsApi = {
  // Sessions
  getSessions: (params: SessionQueryParams = {}) => {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) {
          v.forEach((item) => searchParams.append(k, String(item)));
        } else {
          searchParams.set(k, String(v));
        }
      }
    });
    const query = searchParams.toString();
    return api.get<SessionRecord[]>(`/sessions${query ? `?${query}` : ""}`);
  },

  getSession: (id: string, withRawMessages?: boolean) => {
    const params = withRawMessages ? "?with_raw_messages=true" : "";
    return api.get<SessionRecord>(`/sessions/${id}${params}`);
  },

  getTranscript: async (id: string): Promise<string> => {
    const response = await fetch(`/api/sessions/${id}/transcript`);
    if (!response.ok) {
      throw new Error(`Failed to fetch transcript: ${response.statusText}`);
    }
    return response.text();
  },

  getStats: (params?: { days?: number; machine?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.days) searchParams.set("days", String(params.days));
    if (params?.machine) searchParams.set("machine", params.machine);
    const query = searchParams.toString();
    return api.get<SessionStats>(`/sessions/stats${query ? `?${query}` : ""}`);
  },

  // Machines
  getMachines: () => api.get<MachineRecord[]>("/machines"),

  // Outlines
  triggerOutlines: (sessionIds?: string[]) =>
    api.post("/sessions/outlines", sessionIds ? { sessionIds } : undefined),

  getOutlineProgress: () => api.get<OutlineProgress>("/sessions/outlines/progress"),

  // Sync
  triggerSync: () => api.post("/sessions/sync"),
};
