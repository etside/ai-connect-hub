import { defineTool } from "@lovable.dev/mcp-js";

import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "list_connector_projects",
  title: "List connector projects",
  description: "List the signed-in owner's consumer projects with how many API keys each one has.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const [{ data: projects, error }, { data: keys }] = await Promise.all([
      supabase.from("projects").select("id, name, slug, description, created_at").order("created_at"),
      supabase.from("api_keys").select("id, project_id, revoked"),
    ]);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };

    const rows = (projects ?? []).map((project) => {
      const own = (keys ?? []).filter((k) => k.project_id === project.id);
      return {
        ...project,
        keys_total: own.length,
        keys_active: own.filter((k) => !k.revoked).length,
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { projects: rows },
    };
  },
});
