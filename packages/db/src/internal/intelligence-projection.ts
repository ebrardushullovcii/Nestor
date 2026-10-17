import type { DatabaseSync } from "node:sqlite";
import {
  JobFinderIntelligenceStateSchema,
  type JobFinderIntelligenceState,
} from "@nordri/contracts";
import { getSingletonValue } from "./state";
import { freezeProjection } from "./saved-job-projection";

/** Borrowed, validated singleton; owned canonical reads keep their old contract. */
export function createIntelligenceProjectionReader(database: DatabaseSync) {
  database.exec(`
    CREATE TEMP TABLE intelligence_projection_epoch (revision INTEGER NOT NULL);
    INSERT INTO intelligence_projection_epoch VALUES (0);
    ${["INSERT", "UPDATE", "DELETE"]
      .map(
        (event) => `
      CREATE TEMP TRIGGER intelligence_projection_${event.toLowerCase()}
      AFTER ${event} ON main.singleton_state
      WHEN ${
        event === "UPDATE"
          ? "OLD.key = 'intelligence_state' OR NEW.key = 'intelligence_state'"
          : `${event === "DELETE" ? "OLD" : "NEW"}.key = 'intelligence_state'`
      }
      BEGIN UPDATE intelligence_projection_epoch SET revision = revision + 1; END;
    `,
      )
      .join("\n")}
  `);
  const readRevision = database.prepare(
    "SELECT revision FROM intelligence_projection_epoch",
  );
  const readVersion = database.prepare("PRAGMA data_version");
  let cached: JobFinderIntelligenceState | null = null;
  let cachedRevision = -1;
  let cachedVersion = -1;

  return (): Promise<JobFinderIntelligenceState> => {
    try {
      const revision = Number(readRevision.get()?.revision);
      const version = Number(readVersion.get()?.data_version);
      if (
        !database.isTransaction &&
        cached &&
        cachedRevision === revision &&
        cachedVersion === version
      )
        return Promise.resolve(cached);
      const projection = freezeProjection(
        getSingletonValue(
          database,
          "intelligence_state",
          JobFinderIntelligenceStateSchema,
        ) ?? JobFinderIntelligenceStateSchema.parse({}),
      );
      // A rollback can reuse its revision. Only committed reads enter the cache.
      if (!database.isTransaction) {
        cached = projection;
        cachedRevision = revision;
        cachedVersion = version;
      }
      return Promise.resolve(projection);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };
}
