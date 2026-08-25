import { auth, defineMcp } from "@lovable.dev/mcp-js";

import aiComplete from "./tools/ai-complete";
import listApiKeys from "./tools/list-api-keys";
import listConnectorProjects from "./tools/list-connector-projects";
import usageSummary from "./tools/usage-summary";

// The OAuth issuer must be the direct auth host; the project ref is inlined at build time.
const projectRef = import.meta.env["VITE_SUPABASE_PROJECT_ID"] ?? "project-ref-unset";

export default defineMcp({
  name: "ai-connector-hub",
  title: "AI Connector Hub",
  version: "0.1.0",
  instructions:
    "Tools for the AI Connector Hub. Use ai_complete to run a task-routed completion, list_connector_projects and list_api_keys to inspect issued credentials (secrets are never returned), and usage_summary for spend, latency and error rollups.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [aiComplete, listConnectorProjects, listApiKeys, usageSummary],
});
