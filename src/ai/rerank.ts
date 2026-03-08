import type { Env } from "../env";
import { clampInt, readBoolEnv } from "../utils";

const DEFAULT_RERANK_MODEL = "@cf/baai/bge-reranker-base";
const DEFAULT_RERANK_TOP_N = 20;
const MAX_RERANK_TOP_N = 50;
const DEFAULT_RERANK_MAX_CHARS = 2048;

interface RerankRequestConfig {
  enabled: boolean;
  model?: string;
  topN?: number;
  maxChars?: number;
}

export interface RerankConfig {
  enabled: boolean;
  model: string;
  topN: number;
  maxChars: number;
}

function parseRerankRequestConfig(body: unknown): RerankRequestConfig | null {
  if (!body || typeof body !== "object") return null;

  const record = body as Record<string, unknown>;
  const rerank = record.rerank ?? record.reranking;
  if (rerank === true) return { enabled: true };
  if (!rerank || typeof rerank !== "object" || Array.isArray(rerank)) return null;

  const rerankRecord = rerank as Record<string, unknown>;
  const enabledValue = rerankRecord.enabled;
  const enabled = enabledValue === undefined ? true : Boolean(enabledValue);
  if (!enabled) return null;

  const model = typeof rerankRecord.model === "string" ? rerankRecord.model : undefined;
  const topN = typeof rerankRecord.topN === "number"
    ? rerankRecord.topN
    : typeof rerankRecord.top_n === "number"
      ? rerankRecord.top_n
      : undefined;
  const maxChars = typeof rerankRecord.maxChars === "number"
    ? rerankRecord.maxChars
    : typeof rerankRecord.max_chars === "number"
      ? rerankRecord.max_chars
      : undefined;

  return { enabled: true, model, topN, maxChars };
}

export function resolveRerankConfig(
  env: Pick<Env, "RERANK_DEFAULT_ENABLED" | "RERANK_MODEL">,
  requestBody: unknown,
  requestedTopK: number,
): RerankConfig | null {
  const defaultEnabled = readBoolEnv(env.RERANK_DEFAULT_ENABLED, false);

  const record = requestBody && typeof requestBody === "object" ? (requestBody as Record<string, unknown>) : null;
  const hasRerankKey = Boolean(record && ("rerank" in record || "reranking" in record));

  if (!hasRerankKey) {
    if (!defaultEnabled) return null;

    const model = env.RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL;
    const topN = clampInt(DEFAULT_RERANK_TOP_N, requestedTopK, MAX_RERANK_TOP_N);
    const maxChars = clampInt(DEFAULT_RERANK_MAX_CHARS, 128, 16384);
    return { enabled: true, model, topN, maxChars };
  }

  const rerankValue = record?.rerank ?? record?.reranking;
  if (rerankValue === false) return null;

  const parsed = parseRerankRequestConfig(requestBody);
  if (!parsed) return null;

  const model = parsed.model?.trim() || env.RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL;
  const topN = clampInt(parsed.topN ?? DEFAULT_RERANK_TOP_N, requestedTopK, MAX_RERANK_TOP_N);
  const maxChars = clampInt(parsed.maxChars ?? DEFAULT_RERANK_MAX_CHARS, 128, 16384);

  return { enabled: true, model, topN, maxChars };
}

type RerankResultItem = { id: number; score: number };

export function extractRerankResults(output: unknown): RerankResultItem[] {
  if (!output || typeof output !== "object") return [];

  const record = output as Record<string, unknown>;
  const response = record.response ?? record.results ?? record.data;
  if (!Array.isArray(response)) return [];

  const items: RerankResultItem[] = [];
  for (const value of response) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const idValue = item.id ?? item.index;
    const scoreValue = item.score ?? item.relevance_score ?? item.rerank_score;
    if (typeof idValue !== "number" || !Number.isFinite(idValue)) continue;
    if (typeof scoreValue !== "number" || !Number.isFinite(scoreValue)) continue;
    items.push({ id: Math.trunc(idValue), score: scoreValue });
  }

  return items;
}

