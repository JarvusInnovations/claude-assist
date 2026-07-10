import { api } from "./client";
import type {
  CaptureRecord,
  CaptureListResponse,
  CaptureStatus,
  CaptureType,
  ReferenceListResponse,
} from "@/types/api";

export const captureApi = {
  // List captures, optionally filtered by pipeline status.
  list: (params: { status?: CaptureStatus; limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.limit != null) search.set("limit", String(params.limit));
    if (params.offset != null) search.set("offset", String(params.offset));
    const query = search.toString();
    return api.get<CaptureListResponse>(`/capture${query ? `?${query}` : ""}`);
  },

  get: (ulid: string) => api.get<CaptureRecord>(`/capture/${ulid}`),

  // One-click correction: override the classified type; re-routes immediately.
  correct: (ulid: string, type: CaptureType) =>
    api.post<CaptureRecord>(`/capture/${ulid}/correct`, { type }),

  listReferences: (params: { limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.limit != null) search.set("limit", String(params.limit));
    if (params.offset != null) search.set("offset", String(params.offset));
    const query = search.toString();
    return api.get<ReferenceListResponse>(`/capture/references${query ? `?${query}` : ""}`);
  },
};
