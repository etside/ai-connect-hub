import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  hashApiKey,
  isSupportedModel,
  prefixOf,
  resolveCandidates,
  runCompletion,
  timingSafeEqual,
  type ChatMessage,
} from "@/lib/gateway.server";

const BodySchema = z.object({
  task: z.string().max(40).optional(),
  model: z.string().max(120).optional(),
  system: z.string().max(20000).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1).max(60000),
      }),
    )
    .min(1)
    .max(50),
  max_tokens: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export const Route = createFileRoute("/api/public/v1/chat")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const started = Date.now();
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const auth = request.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer ")) {
          return json({ error: "Missing bearer token." }, 401);
        }
        const presented = auth.slice(7).trim();
        const prefix = prefixOf(presented);
        if (!prefix) return json({ error: "Malformed API key." }, 401);

        const { data: keyRow } = await supabaseAdmin
          .from("api_keys")
          .select("*")
          .eq("key_prefix", prefix)
          .maybeSingle();

        if (!keyRow) return json({ error: "Unknown API key." }, 401);
        const presentedHash = await hashApiKey(presented);
        if (!timingSafeEqual(presentedHash, keyRow.key_hash)) {
          return json({ error: "Unknown API key." }, 401);
        }
        if (keyRow.revoked) return json({ error: "This API key was revoked." }, 401);

        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch (error) {
          return json({ error: "Invalid request body.", details: (error as Error).message }, 400);
        }

        const log = async (fields: Record<string, unknown>) => {
          await supabaseAdmin.from("usage_logs").insert({
            owner_id: keyRow.owner_id,
            project_id: keyRow.project_id,
            api_key_id: keyRow.id,
            source: "http",
            task: body.task ?? "auto",
            requested_model: body.model ?? null,
            latency_ms: Date.now() - started,
            ...fields,
          });
        };

        // Rate limit: requests in the trailing 60 seconds for this key.
        const since = new Date(Date.now() - 60_000).toISOString();
        const { count } = await supabaseAdmin
          .from("usage_logs")
          .select("id", { count: "exact", head: true })
          .eq("api_key_id", keyRow.id)
          .gte("created_at", since);
        if ((count ?? 0) >= keyRow.rate_limit_per_min) {
          await log({ status_code: 429, error: "rate limit exceeded" });
          return new Response(
            JSON.stringify({ error: `Rate limit of ${keyRow.rate_limit_per_min} requests/min exceeded.` }),
            { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60", ...CORS } },
          );
        }

        if (Number(keyRow.tokens_used) >= keyRow.token_cap) {
          await log({ status_code: 402, error: "token cap reached" });
          return json({ error: "This key reached its token budget." }, 402);
        }

        const { lane, routing, candidates } = resolveCandidates(body.task, body.model);
        const allowlist = keyRow.allowed_models ?? [];
        const permitted = candidates.filter(
          (model) => isSupportedModel(model) && (allowlist.length === 0 || allowlist.includes(model)),
        );
        if (permitted.length === 0) {
          await log({ status_code: 403, error: "model outside allowlist", model: candidates[0] ?? null });
          return json({ error: "The requested model is outside this key's allowlist." }, 403);
        }

        const messages: ChatMessage[] = [
          ...(body.system ? ([{ role: "system", content: body.system }] as ChatMessage[]) : []),
          ...body.messages,
        ];

        const outcome = await runCompletion({
          candidates: permitted,
          messages,
          ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        });

        if (!outcome.ok) {
          await log({
            status_code: outcome.failure.status,
            error: outcome.failure.message,
            model: permitted[0] ?? null,
            routing,
          });
          return json({ error: outcome.failure.message, attempts: outcome.failure.attempts }, outcome.failure.status);
        }

        const { result } = outcome;
        const latency = Date.now() - started;
        await log({
          status_code: 200,
          model: result.model,
          routing,
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          total_tokens: result.usage.total_tokens,
        });
        await supabaseAdmin
          .from("api_keys")
          .update({
            tokens_used: Number(keyRow.tokens_used) + result.usage.total_tokens,
            last_used_at: new Date().toISOString(),
          })
          .eq("id", keyRow.id);

        return json({
          text: result.text,
          model: result.model,
          task: lane,
          routing,
          usage: result.usage,
          latency_ms: latency,
        });
      },
    },
  },
});
