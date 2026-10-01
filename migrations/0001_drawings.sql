CREATE TABLE drawings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX drawings_updated_at ON drawings(updated_at DESC);
