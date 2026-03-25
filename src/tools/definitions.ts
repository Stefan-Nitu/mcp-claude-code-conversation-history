import { z } from "zod";

export const historyToolSchema = z.object({
  action: z.enum(["search", "list", "read", "stats"]),
  query: z
    .string()
    .optional()
    .describe(
      "Search keywords (required for search, optional for read to grep within a conversation)",
    ),
  session_id: z
    .string()
    .optional()
    .describe("Session ID from search/list results (required for read)"),
  project: z
    .string()
    .optional()
    .describe("Filter by project name (partial match)"),
  after: z
    .string()
    .optional()
    .describe("Only show conversations after this ISO date"),
  before: z
    .string()
    .optional()
    .describe("Only show conversations before this ISO date"),
  limit: z.number().optional().describe("Maximum number of results"),
  offset: z.number().optional().describe("Skip first N messages (for read)"),
});
