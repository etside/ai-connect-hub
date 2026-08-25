import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "list_api_keys",
  title: "List API keys",
  description:
    "List the owner's API keys with limits, allowlists and status. Secret values are never stored or returned.",
  inputSchema: {
    project_id: z.string().nullable().describe("Optional project id filter; null lists every key."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ project_id }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("api_keys")
      .select(
        "id, project_id, name, key_prefix, allowed_models, rate_limit_per_min, token_cap, tokens_used, revoked, last_used_at, created_at",
      )
      .order("created_at", { ascending: false });
    if (project_id) query = query.eq("project_id", project_id);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { keys: data ?? [] },
    };
  },
});
