import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "usage_summary",
  title: "Usage summary",
  description: "Summarise requests, tokens, errors and latency by model over a recent time window.",
  inputSchema: {
    hours: z.number().int().min(1).max(720).describe("Look-back window in hours, e.g. 24."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ hours }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("usage_logs")
      .select("model, total_tokens, latency_ms, status_code")
      .gte("created_at", since)
      .limit(5000);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };

    const byModel = new Map<
      string,
      { requests: number; tokens: number; errors: number; latency_total: number }
    >();
    for (const row of data ?? []) {
      const key = row.model ?? "unrouted";
      const bucket = byModel.get(key) ?? { requests: 0, tokens: 0, errors: 0, latency_total: 0 };
      bucket.requests += 1;
      bucket.tokens += row.total_tokens ?? 0;
      bucket.latency_total += row.latency_ms ?? 0;
      if ((row.status_code ?? 200) >= 400) bucket.errors += 1;
      byModel.set(key, bucket);
    }

    const models = Array.from(byModel.entries()).map(([model, b]) => ({
      model,
      requests: b.requests,
      tokens: b.tokens,
      errors: b.errors,
      avg_latency_ms: b.requests ? Math.round(b.latency_total / b.requests) : 0,
    }));
    const summary = {
      window_hours: hours,
      requests: (data ?? []).length,
      tokens: models.reduce((sum, m) => sum + m.tokens, 0),
      errors: models.reduce((sum, m) => sum + m.errors, 0),
      models,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
});
