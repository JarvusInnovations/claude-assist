import { api } from "./client";
import type {
  InterruptListResponse,
  NearMissListResponse,
  UrgencyCorrectionResponse,
} from "@/types/api";

export const urgencyApi = {
  listInterrupts: (limit = 50) =>
    api.get<InterruptListResponse>(`/slack-urgency/interrupts?limit=${limit}`),

  listNearMisses: (limit = 50) =>
    api.get<NearMissListResponse>(`/slack-urgency/near-misses?limit=${limit}`),

  // id is the candidate key "<channel>-<ts>".
  correct: (id: string, verdict: "should_interrupt" | "should_not") =>
    api.post<UrgencyCorrectionResponse>(
      `/slack-urgency/${encodeURIComponent(id)}/correct`,
      { verdict }
    ),
};
