// Server-only gateway internals: key hashing, routing with fallbacks, usage logging.
// Lovable AI credentials are read here and never returned to any caller.
import { LANE_CHAINS, isTaskLane, SUPPORTED_MODELS, type TaskLane } from "./routing";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  return out;
}

/** Mints a key. The full secret is returned once and never persisted in clear text. */
export function mintApiKey() {
  const id = randomString(10);
  const secret = randomString(32);
  const prefix = `lvk_live_${id}`;
  return { secret: `${prefix}_${secret}`, prefix };
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function prefixOf(key: string): string | null {
  const parts = key.split("_");
  if (parts.length !== 4 || parts[0] !== "lvk" || parts[1] !== "live") return null;
  return `lvk_live_${parts[2]}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function resolveCandidates(
  task: unknown,
  requestedModel: unknown,
): { lane: TaskLane; routing: string; candidates: string[] } {
  const lane: TaskLane = isTaskLane(task) ? task : "auto";
  if (typeof requestedModel === "string" && requestedModel.length > 0) {
    return { lane, routing: "explicit_model", candidates: [requestedModel] };
  }
  return { lane, routing: `task_route:${lane}`, candidates: LANE_CHAINS[lane] };
}

export function isSupportedModel(model: string): boolean {
  return (SUPPORTED_MODELS as readonly string[]).includes(model);
}

export type CompletionResult = {
  text: string;
  model: string;
  attempts: { model: string; status: number; error?: string }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

export type CompletionFailure = {
  status: number;
  message: string;
  attempts: { model: string; status: number; error?: string }[];
};

/** Walks the candidate chain against Lovable AI, falling back when a model errors. */
export async function runCompletion(options: {
  candidates: string[];
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}): Promise<{ ok: true; result: CompletionResult } | { ok: false; failure: CompletionFailure }> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) {
    return {
      ok: false,
      failure: { status: 500, message: "Gateway is not configured with AI credentials.", attempts: [] },
    };
  }

  const attempts: { model: string; status: number; error?: string }[] = [];

  for (const model of options.candidates) {
    let response: Response;
    try {
      response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": apiKey,
          "X-Lovable-AIG-SDK": "fetch",
        },
        body: JSON.stringify({
          model,
          messages: options.messages,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        }),
      });
    } catch (error) {
      attempts.push({ model, status: 0, error: (error as Error).message });
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      attempts.push({ model, status: response.status, error: body.slice(0, 400) });
      // Terminal, caller-facing statuses: stop walking the chain.
      if (response.status === 402 || response.status === 403 || response.status === 401) {
        return {
          ok: false,
          failure: {
            status: response.status,
            message: extractMessage(body) ?? "Upstream AI request was rejected.",
            attempts,
          },
        };
      }
      continue;
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    attempts.push({ model, status: 200 });

    return {
      ok: true,
      result: {
        text: payload.choices?.[0]?.message?.content ?? "",
        model,
        attempts,
        usage: {
          prompt_tokens: payload.usage?.prompt_tokens ?? 0,
          completion_tokens: payload.usage?.completion_tokens ?? 0,
          total_tokens: payload.usage?.total_tokens ?? 0,
        },
      },
    };
  }

  return {
    ok: false,
    failure: { status: 502, message: "Every candidate model failed.", attempts },
  };
}

function extractMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? null;
  } catch {
    return null;
  }
}
