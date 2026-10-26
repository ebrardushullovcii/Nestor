import {
  PreparedApplicationFormSchema,
  type PreparedApplicationForm,
} from "@nestor/contracts";

import type { JobStore } from "./job-store";

/**
 * A filled form Apply left for the person, kept so the page can be filled
 * again after a restart closed it. Keyed by the application attempt.
 */
export const PREPARED_FORMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS prepared_forms(id TEXT PRIMARY KEY,value TEXT NOT NULL);
`;

export function createPreparedFormsStore(store: JobStore) {
  const { sql } = store;
  return {
    get(id: string): PreparedApplicationForm | null {
      const row = sql("SELECT value FROM prepared_forms WHERE id=?").get(id);
      return row
        ? PreparedApplicationFormSchema.parse(JSON.parse(String(row.value)))
        : null;
    },
    save(form: PreparedApplicationForm): void {
      const value = PreparedApplicationFormSchema.parse(form);
      sql(
        "INSERT INTO prepared_forms(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      ).run(value.id, JSON.stringify(value));
    },
    delete(id: string): void {
      sql("DELETE FROM prepared_forms WHERE id=?").run(id);
    },
  };
}
