import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createSingletonProjectionReader } from "./singleton-projection";

test("borrows only committed singletons and invalidates on local, external and rolled-back writes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "nestor-singleton-projection-"),
  );
  const database = new DatabaseSync(join(directory, "workspace.sqlite"));
  const writer = new DatabaseSync(join(directory, "workspace.sqlite"));
  try {
    database.exec(
      "CREATE TABLE singleton_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)",
    );
    const write = (db: DatabaseSync, value: number) =>
      db
        .prepare(
          "INSERT INTO singleton_state(key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(JSON.stringify({ nested: { value } }));
    const schema = {
      parse: vi.fn((value: unknown) => {
        const candidate = value as { nested: { value: number } };
        if (typeof candidate?.nested?.value !== "number")
          throw new Error("Invalid value");
        return candidate;
      }),
    };
    const read = createSingletonProjectionReader(database);
    const fallback = { nested: { value: 0 } };
    write(database, 1);
    const first = read("profile", schema, fallback);
    expect(Object.isFrozen(first.nested)).toBe(true);
    expect(() => {
      first.nested.value = 99;
    }).toThrow();
    expect(read("profile", schema, fallback)).toBe(first);
    expect(schema.parse).toHaveBeenCalledTimes(1);

    database.exec("BEGIN IMMEDIATE");
    write(database, 2);
    const uncommitted = read("profile", schema, fallback);
    expect(uncommitted.nested.value).toBe(2);
    database.exec("ROLLBACK");
    expect(read("profile", schema, fallback)).toBe(first);
    write(database, 3); // Reuses the rolled-back TEMP epoch.
    expect(read("profile", schema, fallback).nested.value).toBe(3);
    write(writer, 4); // Direct SQL does not advance the persistent revision.
    expect(read("profile", schema, fallback).nested.value).toBe(4);
    database.exec("DELETE FROM singleton_state WHERE key = 'profile'");
    expect(read("profile", schema, fallback)).toEqual(fallback);
    write(database, 5);
    expect(read("profile", schema, fallback).nested.value).toBe(5);
  } finally {
    writer.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
