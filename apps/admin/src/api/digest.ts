import { api } from "./client";
import type {
  DigestPendingResponse,
  DigestHistoryResponse,
  ExecuteResponse,
  GmailAction,
  SenderStanding,
  SenderStandingRow,
  ClassificationRefinement,
} from "@/types/api";

export const digestApi = {
  // Priority-first assembled sections (actionable → categories → archive → spam).
  getPending: () =>
    api.get<DigestPendingResponse>("/google/emails/digest/pending"),

  // Recently executed actions for the history list.
  getHistory: (days = 7) =>
    api.get<DigestHistoryResponse>(`/google/emails/digest/history?days=${days}`),

  // Per-row action override before executing (archive→leave, etc.). Flips the
  // row to workflow_status='reviewed'; the executor reads the updated action.
  updateAction: (id: number, gmail_action: GmailAction) =>
    api.patch(`/google/emails/${id}`, { gmail_action }),

  // Confirm-to-execute the approved ids; applies staged labels + gmail_action.
  execute: (email_ids: number[]) =>
    api.post<ExecuteResponse>("/google/emails/execute", { email_ids }),

  // Newsletter sender standing: whitelist (stop asking) or queue-unsubscribe.
  setSenderStanding: (sender_email: string, standing: SenderStanding) =>
    api.post<SenderStandingRow>("/google/senders/standing", {
      sender_email,
      standing,
      source: "digest_page",
    }),

  // Reclassify one email + queue a refinement. Applies the new placement to
  // THIS email immediately; never mutates triage rules/prompts.
  reclassify: (
    id: number,
    body: {
      to_class: string;
      digest_section?: string;
      gmail_action?: GmailAction;
      note?: string;
    }
  ) =>
    api.post<{ refinement: ClassificationRefinement }>(
      `/google/emails/${id}/reclassify`,
      body
    ),
};
