/**
 * Worker entrypoint for DurableClaw.
 *
 * Exports the NanoChatAgent Durable Object class and provides the
 * default fetch handler that routes requests to the agent or API endpoints.
 */

export { NanoChatAgent } from "./agent/index";

import { routeAgentRequest } from "agents";
import type { Env } from "./env";

/**
 * Handle API routes (currently just /api/health).
 */
function handleApiRequest(
  _request: Request,
  _env: Env,
  url: URL,
): Response {
  if (url.pathname === "/api/health") {
    return Response.json({
      status: "ok",
      service: "durable-claw",
      timestamp: new Date().toISOString(),
    });
  }

  return Response.json(
    { error: "Not found" },
    { status: 404 },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, url);
    }

    // Agent WebSocket and HTTP routing
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Fall through to static assets (SPA)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
