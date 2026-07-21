import { api } from "./client";
import type { PageListResponse } from "@/types/api";

type ArchivedFilter = "exclude" | "include" | "only";

export const pagesApi = {
  /** The enriched pages index. Defaults to including archived so the admin
   * tab sees the whole system (the CLI/agent default is active-only). */
  listPages: (archived: ArchivedFilter = "include") =>
    api.get<PageListResponse>(`/pages?archived=${archived}`),
};
