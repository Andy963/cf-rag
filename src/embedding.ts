import { jsonResponse, parseJson, textResponse, type HttpEnv } from "./http";

const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

export type EmbeddingVector = number[];

export interface EmbeddingEnv extends HttpEnv {
  AI: Ai;
  EMBEDDING_MODEL?: string;
}

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

function getEmbeddingModel(env: EmbeddingEnv): string {
  return env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

function extractDenseVectors(result: unknown): EmbeddingVector[] {
  if (Array.isArray(result)) {
    if (result.every((value) => typeof value === "number")) {
      return [result as EmbeddingVector];
    }

    if (result.every((value) => Array.isArray(value) && (value as unknown[]).every((item) => typeof item === "number"))) {
      return result as EmbeddingVector[];
    }
  }

  if (!result || typeof result !== "object") {
    throw new Error("Invalid AI result");
  }

  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error("AI result missing data");
  }

  if (data.length === 0) return [];

  if (data.every((value) => typeof value === "number")) {
    return [data as EmbeddingVector];
  }

  if (data.every((value) => Array.isArray(value) && (value as unknown[]).every((item) => typeof item === "number"))) {
    return data as EmbeddingVector[];
  }

  const objectVectors = data
    .map((value) => {
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      const embedding = record.embedding ?? record.values;
      if (!Array.isArray(embedding) || !embedding.every((item) => typeof item === "number")) return null;
      return embedding as EmbeddingVector;
    })
    .filter((value): value is EmbeddingVector => value !== null);

  if (objectVectors.length === data.length) return objectVectors;

  throw new Error("Unsupported AI data shape");
}

async function runEmbeddingModel(env: EmbeddingEnv, inputs: string[]): Promise<unknown> {
  const model = getEmbeddingModel(env) as keyof AiModels;
  return await env.AI.run(model, { text: inputs });
}

export async function embedTexts(env: EmbeddingEnv, inputs: string[]): Promise<EmbeddingVector[]> {
  const result = await runEmbeddingModel(env, inputs);
  return extractDenseVectors(result);
}

export async function handleEmbeddingRequest(request: Request, env: EmbeddingEnv): Promise<Response> {
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

    let vectors: EmbeddingVector[];
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
