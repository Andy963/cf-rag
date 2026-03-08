import type { Env } from "../env";
import { extractDenseVectors, getEmbeddingModel, runEmbeddingModel } from "../ai/embedding";
import { jsonResponse, parseJson, textResponse } from "./http";

export function isEmbeddingPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/health" || pathname === "/embed" || pathname === "/v1/embeddings";
}

function normalizeInputs(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];

  const requestBody = body as Record<string, unknown>;
  const input = requestBody.input ?? requestBody.text ?? requestBody.texts;

  if (typeof input === "string") return [input];
  if (Array.isArray(input) && input.every((value) => typeof value === "string")) {
    return input;
  }

  return [];
}

type EmbeddingApiEnv = Pick<Env, "AI" | "CORS_ALLOW_ORIGIN" | "EMBEDDING_MODEL">;

export async function handleEmbeddingRequest(request: Request, env: EmbeddingApiEnv): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return jsonResponse(env, { ok: true, model: getEmbeddingModel(env) });
  }

  if (method === "POST" && (url.pathname === "/embed" || url.pathname === "/v1/embeddings")) {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 400 });
    }

    const inputs = normalizeInputs(body);
    if (inputs.length === 0) {
      return jsonResponse(
        env,
        { error: { message: "Missing input. Use {\"input\":\"...\"} or {\"input\":[\"...\",...]}" } },
        { status: 400 },
      );
    }

    let modelResult: unknown;
    try {
      modelResult = await runEmbeddingModel(env, inputs);
    } catch (error) {
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }

    if (url.pathname === "/embed") {
      return jsonResponse(env, { model: getEmbeddingModel(env), result: modelResult });
    }

    let vectors: number[][];
    try {
      vectors = extractDenseVectors(modelResult);
    } catch (error) {
      return jsonResponse(
        env,
        { error: { message: (error as Error).message }, model: getEmbeddingModel(env), result: modelResult },
        { status: 502 },
      );
    }

    const data = vectors.map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    }));

    return jsonResponse(env, { object: "list", model: getEmbeddingModel(env), data });
  }

  if (method !== "GET" && method !== "POST") {
    return textResponse(env, "Method Not Allowed", { status: 405 });
  }

  return textResponse(env, "Not Found", { status: 404 });
}
