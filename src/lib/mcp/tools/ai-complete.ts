import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

import { resolveCandidates, runCompletion, isSupportedModel, type ChatMessage } from "@/lib/gateway.server";
import { TASK_LANES } from "@/lib/routing";
import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "ai_complete",
  title: "AI complete",
  description:
    "Run a task-routed completion through the hub's gateway. Picks a model from the task lane with ordered fallbacks and records usage.",
  inputSchema: {
    prompt: z.string().min(1).describe("The user prompt to complete."),
    task: z.enum(TASK_LANES).nullable().describe("Routing lane; null routes through the auto lane."),
    system: z.string().nullable().describe("Optional system instruction."),
    model: z.string().nullable().describe("Optional explicit model override, e.g. google/gemini-3.7-flash."),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async ({ prompt, task, system, model }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const started = Date.now();
    const { lane, routing, candidates } = resolveCandidates(task ?? "auto", model ?? undefined);
    const permitted = candidates.filter(isSupportedModel);
    if (permitted.length === 0) {
      return { content: [{ type: "text", text: "Requested model is not supported by this hub." }], isError: true };
    }

    const messages: ChatMessage[] = [
      ...(system ? ([{ role: "system", content: system }] as ChatMessage[]) : []),
      { role: "user", content: prompt },
    ];
    const outcome = await runCompletion({ candidates: permitted, messages });
    const latency = Date.now() - started;

    const supabase = supabaseForUser(ctx);
    await supabase.from("usage_logs").insert({
      owner_id: ctx.getUserId(),
      source: "mcp",
      task: lane,
      requested_model: model ?? null,
      routing,
      latency_ms: latency,
      status_code: outcome.ok ? 200 : outcome.failure.status,
      model: outcome.ok ? outcome.result.model : (permitted[0] ?? null),
      error: outcome.ok ? null : outcome.failure.message,
      prompt_tokens: outcome.ok ? outcome.result.usage.prompt_tokens : 0,
      completion_tokens: outcome.ok ? outcome.result.usage.completion_tokens : 0,
      total_tokens: outcome.ok ? outcome.result.usage.total_tokens : 0,
    });

    if (!outcome.ok) {
      return { content: [{ type: "text", text: outcome.failure.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: outcome.result.text }],
      structuredContent: {
        model: outcome.result.model,
        routing,
        usage: outcome.result.usage,
        latency_ms: latency,
      },
    };
  },
});
