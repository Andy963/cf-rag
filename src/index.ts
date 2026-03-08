import { currentMemoryShape, type PreparedIndexItem, type Primitive, type SearchRequestInput, type StoredMemoryRow } from "./current-memory-shape";
import { embedTexts, handleEmbeddingRequest, isEmbeddingPath, type EmbeddingEnv } from "./embedding";
import { corsHeaders, isAuthorized, jsonResponse, parseJson, textResponse, unauthorizedResponse } from "./http";

const D1_IN_QUERY_CHUNK_SIZE = 200;
const D1_BATCH_CHUNK_SIZE = 50;
const EMBEDDING_BATCH_SIZE = 32;

interface VectorizeMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface VectorizeQueryResult {
  matches?: VectorizeMatch[];
  results?: VectorizeMatch[];
}

interface VectorizeIndex {
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, Primitive>;
    }>,
  ): Promise<void>;
  query(values: number[], options: { topK: number; filter?: Record<string, Primitive> }): Promise<VectorizeQueryResult>;
}

interface Env extends EmbeddingEnv {
  DB: D1Database;
  SEGMENTS_INDEX: VectorizeIndex;
  API_TOKEN?: string;
}

function toQueryMatches(result: VectorizeQueryResult): VectorizeMatch[] {
  const matches = result.matches ?? result.results ?? [];
  return Array.isArray(matches) ? matches : [];
}

function getRequiredApiToken(env: Env): string | null {
  const token = env.API_TOKEN?.trim();
  return token ? token : null;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const normalizedChunkSize = Math.max(1, Math.trunc(chunkSize));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += normalizedChunkSize) {
    chunks.push(items.slice(index, index + normalizedChunkSize));
  }
  return chunks;
}

async function d1FetchExistingHashes(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const hashesById = new Map<string, string>();

  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT id, content_hash FROM memory_segments WHERE id IN (${placeholders})`;
    const result = await db.prepare(sql).bind(...chunk).all();

    for (const row of result.results as Array<Record<string, unknown>>) {
      const id = row.id;
      const contentHash = row.content_hash;
      if (typeof id === "string" && typeof contentHash === "string") {
        hashesById.set(id, contentHash);
      }
    }
  }

  return hashesById;
}

async function d1FetchByIds(db: D1Database, ids: string[]): Promise<Map<string, StoredMemoryRow>> {
  if (ids.length === 0) return new Map();

  const rowsById = new Map<string, StoredMemoryRow>();

  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT id, text, metadata_json, session_id, tape, created_at, updated_at FROM memory_segments WHERE id IN (${placeholders})`;
    const result = await db.prepare(sql).bind(...chunk).all();

    for (const row of result.results as Array<Record<string, unknown>>) {
      const id = row.id;
      if (typeof id === "string") {
        rowsById.set(id, row as StoredMemoryRow);
      }
    }
  }

  return rowsById;
}

function parseRowMetadata(row: StoredMemoryRow): unknown {
  if (typeof row.metadata_json !== "string") return null;

  try {
    return JSON.parse(row.metadata_json);
  } catch {
    return null;
  }
}

async function indexItems(env: Env, preparedItems: PreparedIndexItem[]): Promise<Response> {
  const now = Date.now();
  const existingHashes = await d1FetchExistingHashes(env.DB, preparedItems.map((item) => item.id));

  const itemsToUpsert = preparedItems.filter((item) => existingHashes.get(item.id) !== item.contentHash);
  const skippedItems = preparedItems.filter((item) => existingHashes.get(item.id) === item.contentHash);

  if (itemsToUpsert.length > 0) {
    for (const batch of chunkArray(itemsToUpsert, EMBEDDING_BATCH_SIZE)) {
      const vectors = await embedTexts(
        env,
        batch.map((item) => item.text),
      );

      if (vectors.length !== batch.length) {
        throw new Error(`Embedding count mismatch. expected=${batch.length} actual=${vectors.length}`);
      }

      await env.SEGMENTS_INDEX.upsert(
        batch.map((item, index) => ({
          id: item.id,
          values: vectors[index],
          metadata: item.vectorMetadata,
        })),
      );

      const statements = batch.map((item) =>
        env.DB.prepare(
          "INSERT INTO memory_segments (id, text, content_hash, metadata_json, session_id, tape, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET text=excluded.text, content_hash=excluded.content_hash, metadata_json=excluded.metadata_json, session_id=excluded.session_id, tape=excluded.tape, updated_at=excluded.updated_at",
        ).bind(item.id, item.text, item.contentHash, item.metadataJson, item.sessionId, item.tape, now, now),
      );

      for (const statementBatch of chunkArray(statements, D1_BATCH_CHUNK_SIZE)) {
        await env.DB.batch(statementBatch);
      }
    }
  }

  return jsonResponse(env, {
    ok: true,
    indexed: itemsToUpsert.map((item) => item.id),
    skipped: skippedItems.map((item) => item.id),
    count: {
      total: preparedItems.length,
      indexed: itemsToUpsert.length,
      skipped: skippedItems.length,
    },
  });
}

async function searchItems(env: Env, requestInput: SearchRequestInput): Promise<Response> {
  const requestedTopK = currentMemoryShape.getRequestedTopK(requestInput);
  const candidateTopK = currentMemoryShape.getCandidateTopK(requestInput);
  const filter = currentMemoryShape.getFilter(requestInput);
  const [queryVector] = await embedTexts(env, [currentMemoryShape.getQueryText(requestInput)]);

  let queryResult = await env.SEGMENTS_INDEX.query(queryVector, { topK: candidateTopK, filter });
  let rawMatches = toQueryMatches(queryResult);

  if (filter && rawMatches.length < requestedTopK) {
    queryResult = await env.SEGMENTS_INDEX.query(queryVector, { topK: candidateTopK });
    rawMatches = toQueryMatches(queryResult);
  }

  const matches = rawMatches
    .filter((match) => match && typeof match.id === "string")
    .map((match) => ({
      id: match.id,
      score: typeof match.score === "number" ? match.score : null,
      metadata: match.metadata ?? null,
    }));

  const rowsById = await d1FetchByIds(env.DB, matches.map((match) => match.id));
  const enrichedMatches: Array<Record<string, unknown>> = [];

  for (const match of matches) {
    const row = rowsById.get(match.id);
    if (!row) continue;

    const metadata = parseRowMetadata(row);
    if (!currentMemoryShape.matchesFilter(row, metadata, filter)) continue;

    enrichedMatches.push(currentMemoryShape.toSearchMatch(row, match.score, metadata));
    if (enrichedMatches.length >= requestedTopK) break;
  }

  return jsonResponse(env, { ok: true, topK: requestedTopK, matches: enrichedMatches });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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

    if (isEmbeddingPath(url.pathname)) {
      return await handleEmbeddingRequest(request, env);
    }

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

      const items = currentMemoryShape.normalizeIndexRequest(body);
      if (items.length === 0) {
        return jsonResponse(env, { error: { message: "Missing items. Use {\"text\":\"...\"} or {\"items\":[...]}" } }, { status: 400 });
      }

      try {
        const preparedItems = await currentMemoryShape.prepareIndexItems(items);
        return await indexItems(env, preparedItems);
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

      const requestInput = currentMemoryShape.normalizeSearchRequest(body);
      if (!requestInput) {
        return jsonResponse(env, { error: { message: "Missing query. Use {\"query\":\"...\"}" } }, { status: 400 });
      }

      try {
        return await searchItems(env, requestInput);
      } catch (error) {
        return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
      }
    }

    if (method !== "GET" && method !== "POST") {
      return textResponse(env, "Method Not Allowed", { status: 405 });
    }

    return textResponse(env, "Not Found", { status: 404 });
  },
};
