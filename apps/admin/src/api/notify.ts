import { api } from "./client";
import type {
  NotificationListResponse,
  NotificationPriority,
  NotificationStatus,
  HeartbeatListResponse,
} from "@/types/api";

export const notifyApi = {
  listNotifications: (
    params: { limit?: number; status?: NotificationStatus; priority?: NotificationPriority } = {}
  ) => {
    const search = new URLSearchParams();
    if (params.limit != null) search.set("limit", String(params.limit));
    if (params.status) search.set("status", params.status);
    if (params.priority) search.set("priority", params.priority);
    const query = search.toString();
    return api.get<NotificationListResponse>(`/notifications${query ? `?${query}` : ""}`);
  },

  listHeartbeats: () => api.get<HeartbeatListResponse>("/heartbeats"),
};
