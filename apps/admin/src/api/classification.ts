import { api } from "./client";
import type {
  ClassificationEvent,
  ClassificationEventType,
  SynthesisReport,
} from "@/types/api";

export const classificationApi = {
  listEvents: (
    params: { type?: ClassificationEventType; days?: number; limit?: number } = {}
  ) => {
    const search = new URLSearchParams();
    if (params.type) search.set("type", params.type);
    if (params.days != null) search.set("days", String(params.days));
    if (params.limit != null) search.set("limit", String(params.limit));
    const query = search.toString();
    return api.get<ClassificationEvent[]>(
      `/sessions/classification/events${query ? `?${query}` : ""}`
    );
  },

  listReports: (limit = 20) =>
    api.get<SynthesisReport[]>(`/sessions/classification/reports?limit=${limit}`),
};
