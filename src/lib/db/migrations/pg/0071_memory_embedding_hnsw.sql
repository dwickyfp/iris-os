-- ANN index for cosine-distance memory recall (ORDER BY vector_value <=> $1).
-- pgvector can only build an ANN index on a vector column with FIXED
-- dimensions. The column starts dimensionless (migration 0019) because the
-- dimension depends on the configured embedding model. The index is created
-- only when a deployment has already pinned the column type to vector(n)
-- (via ALTER TABLE ... TYPE vector(n)). Dimensionless columns keep exact
-- (sequential) distance scans, which remain correct.
DO $$
DECLARE
  typmod integer;
BEGIN
  SELECT a.atttypmod
    INTO typmod
    FROM pg_attribute a
   WHERE a.attrelid = 'memory_embedding'::regclass
     AND a.attname = 'vector_value'
     AND a.attisdropped = false;
  -- pgvector encodes dimensions as typmod - 4.
  IF typmod > 4 THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON memory_embedding USING hnsw (vector_value vector_cosine_ops)',
      'memory_embedding_vector_hnsw'
    );
  END IF;
END
$$;
