import type { Env } from "../env";
import { handleEmbeddingRequest, isEmbeddingPath } from "./embedding";
import { handleMemoryRequest } from "./memory";
import { textResponse } from "./http";

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (isEmbeddingPath(url.pathname)) {
    return await handleEmbeddingRequest(request, env);
  }

  if (url.pathname.startsWith("/memory/")) {
    return await handleMemoryRequest(request, env);
  }

  if (method !== "GET" && method !== "POST") {
    return textResponse(env, "Method Not Allowed", { status: 405 });
  }

  return textResponse(env, "Not Found", { status: 404 });
}

