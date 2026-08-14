ALTER TABLE "memory_topic" ADD CONSTRAINT "memory_topic_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "memory_entity" ADD CONSTRAINT "memory_entity_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "memory_edge" ADD CONSTRAINT "memory_edge_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "memory_embedding" ADD CONSTRAINT "memory_embedding_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "memory_curator_run" ADD CONSTRAINT "memory_curator_run_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "memory_retrieval_audit" ADD CONSTRAINT "memory_retrieval_audit_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "learning_observation" ADD CONSTRAINT "learning_observation_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "learning_candidate" ADD CONSTRAINT "learning_candidate_scope_check"
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "learning_observation" ADD CONSTRAINT "learning_observation_confidence_check"
  CHECK ("confidence" BETWEEN 0 AND 100);
ALTER TABLE "learning_candidate" ADD CONSTRAINT "learning_candidate_confidence_check"
  CHECK ("confidence" BETWEEN 0 AND 100);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION iris_memory_node_matches_scope(
  expected_user_id uuid,
  node_type varchar,
  node_id uuid,
  expected_scope_type varchar,
  expected_scope_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF node_type = 'claim' THEN
    RETURN EXISTS (
      SELECT 1 FROM user_memory
      WHERE id = node_id AND user_id = expected_user_id
        AND scope_type = expected_scope_type
        AND scope_id IS NOT DISTINCT FROM expected_scope_id
    );
  ELSIF node_type = 'topic' THEN
    RETURN EXISTS (
      SELECT 1 FROM memory_topic
      WHERE id = node_id AND user_id = expected_user_id
        AND scope_type = expected_scope_type
        AND scope_id IS NOT DISTINCT FROM expected_scope_id
    );
  ELSIF node_type = 'entity' THEN
    RETURN EXISTS (
      SELECT 1 FROM memory_entity
      WHERE id = node_id AND user_id = expected_user_id
        AND scope_type = expected_scope_type
        AND scope_id IS NOT DISTINCT FROM expected_scope_id
    );
  END IF;
  RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION iris_enforce_memory_edge_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT iris_memory_node_matches_scope(
    NEW.user_id, NEW.source_type, NEW.source_id, NEW.scope_type, NEW.scope_id
  ) OR NOT iris_memory_node_matches_scope(
    NEW.user_id, NEW.target_type, NEW.target_id, NEW.scope_type, NEW.scope_id
  ) THEN
    RAISE EXCEPTION 'memory edge nodes must exist in the exact same user scope';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER memory_edge_exact_scope_trigger
BEFORE INSERT OR UPDATE OF user_id, scope_type, scope_id, source_id,
  source_type, target_id, target_type ON memory_edge
FOR EACH ROW EXECUTE FUNCTION iris_enforce_memory_edge_scope();
