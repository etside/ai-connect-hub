import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  hashApiKey,
  isSupportedModel,
  mintApiKey,
  resolveCandidates,
  runCompletion,
  type ChatMessage,
} from "@/lib/gateway.server";

export const listProjects = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const slug =
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "project";
    const { data: row, error } = await context.supabase
      .from("projects")
      .insert({
        owner_id: context.userId,
        name: data.name,
        slug: `${slug}-${Math.random().toString(36).slice(2, 6)}`,
        description: data.description ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("projects").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("api_keys")
      .select("id, project_id, name, key_prefix, allowed_models, rate_limit_per_min, token_cap, tokens_used, revoked, last_used_at, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        project_id: z.string().uuid(),
        name: z.string().trim().min(1).max(80),
        allowed_models: z.array(z.string()).max(20),
        rate_limit_per_min: z.number().int().min(1).max(600),
        token_cap: z.number().int().min(1000).max(50_000_000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const allowed = data.allowed_models.filter(isSupportedModel);
    const { secret, prefix } = mintApiKey();
    const { data: row, error } = await context.supabase
      .from("api_keys")
      .insert({
        owner_id: context.userId,
        project_id: data.project_id,
        name: data.name,
        key_prefix: prefix,
        key_hash: await hashApiKey(secret),
        allowed_models: allowed,
        rate_limit_per_min: data.rate_limit_per_min,
        token_cap: data.token_cap,
      })
      .select("id, key_prefix, name")
      .single();
    if (error) throw new Error(error.message);
    // The only moment the plaintext secret exists outside the caller's request.
    return { ...row, secret };
  });

export const updateKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        revoked: z.boolean().optional(),
        rate_limit_per_min: z.number().int().min(1).max(600).optional(),
        token_cap: z.number().int().min(1000).max(50_000_000).optional(),
        allowed_models: z.array(z.string()).max(20).optional(),
        reset_tokens: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.revoked !== undefined) patch["revoked"] = data.revoked;
    if (data.rate_limit_per_min !== undefined) patch["rate_limit_per_min"] = data.rate_limit_per_min;
    if (data.token_cap !== undefined) patch["token_cap"] = data.token_cap;
    if (data.allowed_models !== undefined) patch["allowed_models"] = data.allowed_models.filter(isSupportedModel);
    if (data.reset_tokens) patch["tokens_used"] = 0;
    const { error } = await context.supabase.from("api_keys").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("usage_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const runPlayground = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        task: z.string().max(40),
        model: z.string().max(120).optional(),
        system: z.string().max(4000).optional(),
        prompt: z.string().trim().min(1).max(20000),
        project_id: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const started = Date.now();
    const { lane, routing, candidates } = resolveCandidates(data.task, data.model);
    const permitted = candidates.filter(isSupportedModel);
    const messages: ChatMessage[] = [
      ...(data.system ? ([{ role: "system", content: data.system }] as ChatMessage[]) : []),
      { role: "user", content: data.prompt },
    ];
    const outcome = await runCompletion({ candidates: permitted, messages });
    const latency = Date.now() - started;

    await context.supabase.from("usage_logs").insert({
      owner_id: context.userId,
      project_id: data.project_id ?? null,
      source: "playground",
      task: lane,
      requested_model: data.model ?? null,
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
      return { ok: false as const, error: outcome.failure.message, status: outcome.failure.status };
    }
    return {
      ok: true as const,
      text: outcome.result.text,
      model: outcome.result.model,
      routing,
      usage: outcome.result.usage,
      latency_ms: latency,
    };
  });
