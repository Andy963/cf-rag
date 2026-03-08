import type { Primitive } from "../env";

export interface IndexItemInput {
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SearchRequestInput {
  query: string;
  topK?: number;
  filter?: Record<string, Primitive>;
}

export interface PreparedIndexItem {
  item: IndexItemInput;
  id: string;
  text: string;
  contentHash: string;
  metadataJson: string;
  sessionId: string | null;
  tape: string | null;
  vectorMetadata?: Record<string, Primitive>;
}

export interface StoredMemoryRow extends Record<string, unknown> {
  id: string;
}

export interface MemoryShapeAdapter {
  normalizeIndexRequest(body: unknown): IndexItemInput[];
  normalizeSearchRequest(body: unknown): SearchRequestInput | null;
  prepareIndexItems(items: IndexItemInput[]): Promise<PreparedIndexItem[]>;
  getQueryText(request: SearchRequestInput): string;
  getRequestedTopK(request: SearchRequestInput): number;
  getCandidateTopK(request: SearchRequestInput): number;
  getFilter(request: SearchRequestInput): Record<string, Primitive> | undefined;
  matchesFilter(row: StoredMemoryRow | undefined, metadata: unknown, filter?: Record<string, Primitive>): boolean;
  toSearchMatch(row: StoredMemoryRow, score: number | null, metadata: unknown): Record<string, unknown>;
}

function isIndexItemInput(value: unknown): value is IndexItemInput {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") return false;
  if (record.id !== undefined && typeof record.id !== "string") return false;
  if (record.metadata !== undefined && (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata))) {
    return false;
  }

  return true;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildVectorMetadata(metadata?: Record<string, unknown>): Record<string, Primitive> | undefined {
  if (!metadata) return undefined;

  const projected: Record<string, Primitive> = {};
  for (const key of ["session_id", "tape", "kind", "chat_id", "user_id"]) {
    const value = metadata[key];
    if (typeof value === "string" && value) projected[key] = value;
    if (typeof value === "number" && Number.isFinite(value)) projected[key] = value;
    if (typeof value === "boolean") projected[key] = value;
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resolveItemId(item: IndexItemInput): Promise<string> {
  if (item.id && item.id.trim()) return item.id.trim();

  const sessionId = safeString(item.metadata?.session_id) ?? "";
  const tape = safeString(item.metadata?.tape) ?? "";
  const basis = `${sessionId}\n${tape}\n${item.text}`;
  const hash = await sha256Hex(basis);
  return `seg_${hash.slice(0, 32)}`;
}

function getByPath(source: unknown, path: string): unknown {
  if (!source || typeof source !== "object") return undefined;

  const parts = path.split(".").filter((part) => part);
  let current: unknown = source;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    if (!(part in record)) return undefined;
    current = record[part];
  }

  return current;
}

function matchesPrimitive(actual: unknown, expected: Primitive): boolean {
  if (typeof expected === "string") return typeof actual === "string" && actual === expected;
  if (typeof expected === "number") return typeof actual === "number" && actual === expected;
  if (typeof expected === "boolean") return typeof actual === "boolean" && actual === expected;
  return false;
}

export const defaultMemorySchema: MemoryShapeAdapter = {
  normalizeIndexRequest(body: unknown): IndexItemInput[] {
    if (Array.isArray(body)) {
      return body.filter(isIndexItemInput);
    }

    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      if (Array.isArray(record.items)) {
        return record.items.filter(isIndexItemInput);
      }
    }

    if (isIndexItemInput(body)) return [body];
    return [];
  },

  normalizeSearchRequest(body: unknown): SearchRequestInput | null {
    if (!body || typeof body !== "object") return null;

    const record = body as Record<string, unknown>;
    if (typeof record.query !== "string") return null;

    const topK = typeof record.topK === "number" ? record.topK : undefined;
    const filter = record.filter && typeof record.filter === "object" && !Array.isArray(record.filter)
      ? (record.filter as Record<string, Primitive>)
      : undefined;

    return { query: record.query, topK, filter };
  },

  async prepareIndexItems(items: IndexItemInput[]): Promise<PreparedIndexItem[]> {
    return await Promise.all(
      items.map(async (item) => {
        const id = await resolveItemId(item);
        const contentHash = await sha256Hex(item.text);
        const metadataJson = JSON.stringify(item.metadata ?? {});
        const sessionId = safeString(item.metadata?.session_id);
        const tape = safeString(item.metadata?.tape);

        return {
          item,
          id,
          text: item.text,
          contentHash,
          metadataJson,
          sessionId,
          tape,
          vectorMetadata: buildVectorMetadata(item.metadata),
        };
      }),
    );
  },

  getQueryText(request: SearchRequestInput): string {
    return request.query;
  },

  getRequestedTopK(request: SearchRequestInput): number {
    return clampInt(request.topK ?? 5, 1, 50);
  },

  getCandidateTopK(request: SearchRequestInput): number {
    const requestedTopK = clampInt(request.topK ?? 5, 1, 50);
    return request.filter ? clampInt(requestedTopK * 20, requestedTopK, 200) : requestedTopK;
  },

  getFilter(request: SearchRequestInput): Record<string, Primitive> | undefined {
    return request.filter;
  },

  matchesFilter(row: StoredMemoryRow | undefined, metadata: unknown, filter?: Record<string, Primitive>): boolean {
    if (!filter) return true;

    for (const [key, expected] of Object.entries(filter)) {
      let actual: unknown;
      if (key === "session_id") actual = row?.session_id;
      else if (key === "tape") actual = row?.tape;
      else actual = getByPath(metadata, key);

      if (!matchesPrimitive(actual, expected)) return false;
    }

    return true;
  },

  toSearchMatch(row: StoredMemoryRow, score: number | null, metadata: unknown): Record<string, unknown> {
    return {
      id: row.id,
      score,
      text: row.text ?? null,
      metadata,
      session_id: row.session_id ?? null,
      tape: row.tape ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    };
  },
};
