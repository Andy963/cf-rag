import type { VectorizeMatch, VectorizeQueryResult } from "../env";

export function toQueryMatches(result: VectorizeQueryResult): VectorizeMatch[] {
  const matches = result.matches ?? result.results ?? [];
  return Array.isArray(matches) ? matches : [];
}

