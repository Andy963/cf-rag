import type { Env } from "../env";
import { embedTexts } from "../ai/embedding";
import { fetchExistingHashes, upsertSegments } from "../db/d1";
import type { PreparedIndexItem } from "./schema";
import { chunkArray } from "../utils";

const EMBEDDING_BATCH_SIZE = 32;

export interface MemoryIndexResult {
  ok: true;
  indexed: string[];
  skipped: string[];
  count: {
    total: number;
    indexed: number;
    skipped: number;
  };
}

export async function indexMemoryItems(env: Env, preparedItems: PreparedIndexItem[]): Promise<MemoryIndexResult> {
  const now = Date.now();
  const existingHashes = await fetchExistingHashes(env.DB, preparedItems.map((item) => item.id));

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

      await upsertSegments(env.DB, batch, now);
    }
  }

  return {
    ok: true,
    indexed: itemsToUpsert.map((item) => item.id),
    skipped: skippedItems.map((item) => item.id),
    count: {
      total: preparedItems.length,
      indexed: itemsToUpsert.length,
      skipped: skippedItems.length,
    },
  };
}

