import { api } from "./client";
import type {
  AlertPlan,
  OverrideListResponse,
  OverrideAction,
  SeriesOverride,
} from "@/types/api";

export const briefingApi = {
  // Resolved alert plan for a date (defaults to today when date omitted).
  getAlertPlan: (date?: string) =>
    api.get<AlertPlan>(`/briefing/alert-plan${date ? `?date=${encodeURIComponent(date)}` : ""}`),

  listOverrides: () => api.get<OverrideListResponse>("/briefing/overrides"),

  upsertOverride: (
    seriesId: string,
    body: { action: OverrideAction; leadMinutes?: number | null; note?: string | null }
  ) => api.put<SeriesOverride>(`/briefing/overrides/${encodeURIComponent(seriesId)}`, body),

  removeOverride: (seriesId: string) =>
    api.delete<{ seriesId: string; removed: boolean }>(
      `/briefing/overrides/${encodeURIComponent(seriesId)}`
    ),
};
