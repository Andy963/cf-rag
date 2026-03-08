import type { Env } from "../env";

const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

export type EmbeddingVector = number[];

export type EmbeddingEnv = Pick<Env, "AI" | "EMBEDDING_MODEL">;

export function getEmbeddingModel(env: Pick<Env, "EMBEDDING_MODEL">): string {
  return env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export function extractDenseVectors(result: unknown): EmbeddingVector[] {
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

export async function runEmbeddingModel(env: EmbeddingEnv, inputs: string[]): Promise<unknown> {
  const model = getEmbeddingModel(env) as keyof AiModels;
  return await env.AI.run(model, { text: inputs });
}

export async function embedTexts(env: EmbeddingEnv, inputs: string[]): Promise<EmbeddingVector[]> {
  const result = await runEmbeddingModel(env, inputs);
  return extractDenseVectors(result);
}

