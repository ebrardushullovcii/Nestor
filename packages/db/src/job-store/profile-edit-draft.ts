import {
  ProfileEditsDraftSchema,
  type ProfileEditsDraft,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";
export const PROFILE_EDIT_DRAFT_SCHEMA = `CREATE TABLE IF NOT EXISTS profile_edit_draft(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,value TEXT NOT NULL);`;
/** An unresolved edit is a detail-only draft, never canonical Profile data. */
export function createProfileEditDraftStore(store: JobStore) {
  return {
    read(): ProfileEditsDraft | null {
      const row = store
        .sql("SELECT token,value FROM profile_edit_draft WHERE id=1")
        .get();
      return row
        ? ProfileEditsDraftSchema.parse({
            id: row.token,
            edits: JSON.parse(String(row.value)) as unknown,
          })
        : null;
    },
    put(input: ProfileEditsDraft): { saved: true } {
      const draft = ProfileEditsDraftSchema.parse(input);
      store.transaction(() =>
        store
          .sql(
            "INSERT INTO profile_edit_draft(id,token,value) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,value=excluded.value WHERE token<>excluded.token OR value<>excluded.value",
          )
          .run(draft.id, JSON.stringify(draft.edits)),
      );
      return { saved: true };
    },
    clear(id: string) {
      return {
        removed: Boolean(
          store.transaction(
            () =>
              store
                .sql("DELETE FROM profile_edit_draft WHERE id=1 AND token=?")
                .run(id).changes,
          ),
        ),
      };
    },
  };
}
