import type { Env } from "./env";
import { routeRequest } from "./api/router";
import { corsHeaders, isAuthorized, jsonResponse, unauthorizedResponse } from "./api/http";

function getRequiredApiToken(env: Env): string | null {
  const token = env.API_TOKEN?.trim();
  return token ? token : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const apiToken = getRequiredApiToken(env);
    if (!apiToken) {
      return jsonResponse(env, { error: { message: "API_TOKEN is required" } }, { status: 500 });
    }

    if (!isAuthorized(request, apiToken)) {
      return unauthorizedResponse(env, "cf-rag");
    }

    return await routeRequest(request, env);
  },
};
