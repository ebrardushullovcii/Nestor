import { jobStageValues } from "@nestor/contracts";

import type { JobStore } from "./job-store";
import { JOB_STORE_SCHEMA } from "./schema";

/**
 * Reset everything: drops every table and makes it again, as in a new file,
 * then rewrites the file so nothing removed stays on disk. Prepared
 * statements prepare again on their next use.
 */
export function resetJobStore(store: JobStore): void {
  const { db } = store;
  // The foreign-key switch and VACUUM below only work between transactions.
  if (db.isTransaction)
    throw new Error("The job store can't be reset inside a transaction.");
  const tables = () =>
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'",
      )
      .all() as { name: string; sql: string }[];
  // Off for the drop, so no table checks one that is already gone. It only
  // changes outside a transaction.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    store.transaction(() => {
      // A full-text table goes first and takes its own tables with it.
      for (const { name, sql } of tables())
        if (/^CREATE VIRTUAL TABLE/iu.test(sql))
          db.exec(`DROP TABLE "${name}"`);
      for (const { name } of tables()) db.exec(`DROP TABLE "${name}"`);
      for (const ddl of JOB_STORE_SCHEMA) db.exec(ddl);
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  // Every view refreshes: stage lists and counts, Applications and Needs you,
  // and the job sites.
  store.notify({
    cause: "application",
    stages: [...jobStageValues],
    ids: null,
    searchId: null,
  });
  store.notify({ cause: "sites", stages: [], ids: null, searchId: null });
}
