import type { Env } from "../env";
import { indexMemoryItems } from "../memory/indexer";
import { defaultMemorySchema } from "../memory/schema";
import { searchMemoryItems } from "../memory/searcher";
import { jsonResponse, parseJson, textResponse } from "./http";

export async function handleMemoryRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "GET" && url.pathname === "/memory/health") {
    return jsonResponse(env, { ok: true });
  }

  if (method === "POST" && url.pathname === "/memory/index") {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 400 });
    }

    const items = defaultMemorySchema.normalizeIndexRequest(body);
    if (items.length === 0) {
      return jsonResponse(env, { error: { message: "Missing items. Use {\"text\":\"...\"} or {\"items\":[...]}" } }, { status: 400 });
    }

    try {
      const preparedItems = await defaultMemorySchema.prepareIndexItems(items);
      const result = await indexMemoryItems(env, preparedItems);
      return jsonResponse(env, result);
    } catch (error) {
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "POST" && url.pathname === "/memory/search") {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 400 });
    }

    const requestInput = defaultMemorySchema.normalizeSearchRequest(body);
    if (!requestInput) {
      return jsonResponse(env, { error: { message: "Missing query. Use {\"query\":\"...\"}" } }, { status: 400 });
    }

    try {
      const result = await searchMemoryItems(env, requestInput, body);
      return jsonResponse(env, result);
    } catch (error) {
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method !== "GET" && method !== "POST") {
    return textResponse(env, "Method Not Allowed", { status: 405 });
  }

  return textResponse(env, "Not Found", { status: 404 });
}

