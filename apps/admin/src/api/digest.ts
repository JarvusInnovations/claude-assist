import { api } from "./client";
import type {
  DigestPendingResponse,
  DigestHistoryResponse,
  ExecuteResponse,
  GmailAction,
} from "@/types/api";

export const digestApi = {
  // Current pending-action emails grouped by digest_section.
  getPending: () =>
    api.get<DigestPendingResponse>("/google/emails/digest/pending"),

  // Recently executed actions (applied_* columns) for the history list.
  getHistory: (days = 7) =>
    api.get<DigestHistoryResponse>(`/google/emails/digest/history?days=${days}`),

  // Per-row action override before executing (archive→leave, etc.). Flips the
  // row to workflow_status='reviewed'; the executor reads the updated action.
  updateAction: (id: number, gmail_action: GmailAction) =>
    api.patch(`/google/emails/${id}`, { gmail_action }),

  // Confirm-to-execute the approved ids; applies staged labels + gmail_action.
  execute: (email_ids: number[]) =>
    api.post<ExecuteResponse>("/google/emails/execute", { email_ids }),
};
