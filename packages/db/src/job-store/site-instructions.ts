import {
  SourceInstructionArtifactSchema,
  type SourceInstructionArtifact,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";

/**
 * What "check this site" learned about a job site, which search and Apply
 * pass to the model. One row per saved artifact; old workspace artifacts are
 * not copied, and a check writes new ones.
 */
export const SITE_INSTRUCTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS site_instructions(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,updated_at TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS site_instructions_target ON site_instructions(target_id,id);
`;

export function createSiteInstructionsStore(store: JobStore) {
  const { sql } = store;
  const upsert = (artifact: SourceInstructionArtifact): void => {
    const row = SourceInstructionArtifactSchema.parse(artifact);
    sql(
      `INSERT INTO site_instructions(id,target_id,updated_at,value) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET target_id=excluded.target_id,updated_at=excluded.updated_at,value=excluded.value`,
    ).run(row.id, row.targetId, row.updatedAt, JSON.stringify(row));
  };
  return {
    list(): SourceInstructionArtifact[] {
      return sql("SELECT value FROM site_instructions ORDER BY id")
        .all()
        .map((row) =>
          SourceInstructionArtifactSchema.parse(JSON.parse(String(row.value))),
        );
    },
    upsert,
    deleteForSite(targetId: string): void {
      sql("DELETE FROM site_instructions WHERE target_id = ?").run(targetId);
    },
    replace(artifacts: readonly SourceInstructionArtifact[]): void {
      store.transaction(() => {
        sql("DELETE FROM site_instructions").run();
        for (const artifact of artifacts) upsert(artifact);
      });
    },
  };
}
