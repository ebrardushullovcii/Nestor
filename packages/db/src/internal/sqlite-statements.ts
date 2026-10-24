import type { DatabaseSync, StatementSync } from "node:sqlite";

const connections = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Reuse compiled SQL for the connection's lifetime, never its result rows. */
export function prepareStatement(
  database: DatabaseSync,
  sql: string,
): StatementSync {
  let statements = connections.get(database);
  if (!statements)
    connections.set(database, (statements = new Map<string, StatementSync>()));
  let statement = statements.get(sql);
  if (!statement) statements.set(sql, (statement = database.prepare(sql)));
  return statement;
}
