import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Prepares each SQL text once and hands back the same statement after. */
export type Statements = (sql: string) => StatementSync;

export function createStatements(db: DatabaseSync): Statements {
  const cache = new Map<string, StatementSync>();
  return (sql) => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };
}
