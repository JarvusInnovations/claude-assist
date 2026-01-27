import { api } from "./client";
import type {
  GoogleAccount,
  UserAlias,
  EmailRecord,
  EmailStats,
  EmailQueryParams,
  TriageProgress,
  CreateAccountPayload,
  UpdateAccountPayload,
  CreateAliasPayload,
} from "@/types/api";

export const googleApi = {
  // Accounts
  getAccounts: () => api.get<GoogleAccount[]>("/google/accounts"),

  getAccount: (id: number) => api.get<GoogleAccount>(`/google/accounts/${id}`),

  createAccount: (data: CreateAccountPayload) =>
    api.post<{ id: number; authUrl: string }>("/google/accounts", data),

  updateAccount: (id: number, data: UpdateAccountPayload) =>
    api.patch<GoogleAccount>(`/google/accounts/${id}`, data),

  deleteAccount: (id: number) => api.delete(`/google/accounts/${id}`),

  getReauthUrl: (id: number) =>
    api.post<{ authUrl: string }>(`/google/accounts/${id}/reauth`),

  // Aliases
  getAliases: (accountId: number) =>
    api.get<UserAlias[]>(`/google/accounts/${accountId}/aliases`),

  createAlias: (accountId: number, data: CreateAliasPayload) =>
    api.post<UserAlias>(`/google/accounts/${accountId}/aliases`, data),

  deleteAlias: (accountId: number, aliasId: number) =>
    api.delete(`/google/accounts/${accountId}/aliases/${aliasId}`),

  // Emails
  getEmails: (params: EmailQueryParams = {}) => {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        searchParams.set(k, String(v));
      }
    });
    const query = searchParams.toString();
    return api.get<EmailRecord[]>(`/google/emails${query ? `?${query}` : ""}`);
  },

  getEmail: (id: number) => api.get<EmailRecord>(`/google/emails/${id}`),

  getEmailStats: (params?: { account?: string; days?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.account) searchParams.set("account", params.account);
    if (params?.days) searchParams.set("days", String(params.days));
    const query = searchParams.toString();
    return api.get<EmailStats>(`/google/emails/stats${query ? `?${query}` : ""}`);
  },

  // Sync & Triage
  triggerSync: (params?: { account?: string; full?: boolean }) =>
    api.post("/google/emails/sync", params),

  triggerTriage: (params?: { account?: string; limit?: number }) =>
    api.post("/google/emails/triage", params),

  triageEmail: (id: number) =>
    api.post(`/google/emails/${id}/triage`),

  getTriageProgress: () => api.get<TriageProgress>("/google/emails/triage/progress"),
};
