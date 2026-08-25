// Shared (client-safe) routing table for the gateway and the docs page.

export const TASK_LANES = [
  "auto",
  "chat",
  "fast",
  "classify",
  "extract",
  "summarize",
  "code",
  "reasoning",
] as const;

export type TaskLane = (typeof TASK_LANES)[number];

export const SUPPORTED_MODELS = [
  "google/gemini-3.7-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview",
  "google/gemini-2.5-pro",
] as const;

export const MODEL_NOTES: Record<string, string> = {
  "google/gemini-3.1-flash-lite": "Cheapest + fastest. Classification, extraction, high volume.",
  "google/gemini-3.7-flash": "Default workhorse. Chat, coding, agentic steps.",
  "google/gemini-3.5-flash": "Balanced fallback for the 3.7 lane.",
  "google/gemini-3.1-pro-preview": "Deep reasoning and hard analysis.",
  "google/gemini-2.5-pro": "Large context reasoning fallback.",
};

/** Ordered candidate chains — the gateway walks each chain until one succeeds. */
export const LANE_CHAINS: Record<TaskLane, string[]> = {
  auto: ["google/gemini-3.7-flash", "google/gemini-3.5-flash", "google/gemini-3.1-flash-lite"],
  chat: ["google/gemini-3.7-flash", "google/gemini-3.5-flash"],
  fast: ["google/gemini-3.1-flash-lite", "google/gemini-3.5-flash"],
  classify: ["google/gemini-3.1-flash-lite", "google/gemini-3.7-flash"],
  extract: ["google/gemini-3.1-flash-lite", "google/gemini-3.7-flash"],
  summarize: ["google/gemini-3.5-flash", "google/gemini-3.7-flash"],
  code: ["google/gemini-3.7-flash", "google/gemini-3.5-flash", "google/gemini-2.5-pro"],
  reasoning: [
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-pro",
    "google/gemini-3.7-flash",
  ],
};

export const LANE_DESCRIPTIONS: Record<TaskLane, string> = {
  auto: "No hint given — balanced default chain.",
  chat: "Conversational replies and assistants.",
  fast: "Latency-sensitive, high-volume calls.",
  classify: "Labels, routing decisions, yes/no calls.",
  extract: "Structured field extraction from text.",
  summarize: "Condensing documents and changelogs.",
  code: "Code generation, review and refactors.",
  reasoning: "Multi-step analysis and hard problems.",
};

export function isTaskLane(value: unknown): value is TaskLane {
  return typeof value === "string" && (TASK_LANES as readonly string[]).includes(value);
}
