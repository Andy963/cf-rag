CREATE TABLE IF NOT EXISTS memory_segments (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  tape TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_segments_session_id ON memory_segments(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_segments_tape ON memory_segments(tape);
CREATE INDEX IF NOT EXISTS idx_memory_segments_updated_at ON memory_segments(updated_at);

