import {
  ApplicationAuthorityEnvelopeSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
} from "@nestor/contracts";

import { createApplicationAnswerSnapshotRepositoryMethods } from "../application-answer-snapshot-repository";
import type { ApplicationAnswerSnapshotRepository } from "../application-answer-snapshot-repository-types";
import { createApplicationAuthorityRepositoryMethods } from "../application-authority-repository";
import type {
  ApplicationAuthorityRepository,
  SendGuardState,
} from "../application-authority-repository-types";
import type { JobStore } from "./job-store";

/**
 * What the send guards decide from: who may send what (authorities), each
 * send's preflight, grant, once-only key, armed marker and outcome, and the
 * saved answers a send was approved against. One row per record, its JSON in
 * `value`; the other columns are copies the unique indexes hold to. Rows are
 * never deleted, preflights, markers, outcomes and approved answers never
 * change, and the rest change only through the guards' own transitions.
 */
export const SEND_GUARDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS send_authorities(id TEXT PRIMARY KEY,status TEXT NOT NULL,value TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS send_authorities_one_active ON send_authorities(status) WHERE status='active';
CREATE TABLE IF NOT EXISTS send_preflights(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS send_grants(id TEXT PRIMARY KEY,preflight_id TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS send_keys(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,preflight_id TEXT NOT NULL UNIQUE,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS send_markers(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,preflight_id TEXT NOT NULL UNIQUE,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS send_outcomes(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS send_outcomes_by_job ON send_outcomes(job_id,id);
CREATE TABLE IF NOT EXISTS answer_approvals(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,UNIQUE(profile_id,revision));
`;

type Collection = keyof SendGuardState;
type Row<K extends Collection> = NonNullable<SendGuardState[K]>[number];

interface Table<K extends Collection> {
  name: string;
  parse(value: unknown): Row<K>;
  /** The indexed copies, in the table's column order after `id`. */
  keys(value: Row<K>): (string | number)[];
  columns: readonly string[];
  /** Written once and never changed. */
  once?: true;
}

const table = <K extends Collection>(spec: Table<K>) => spec;

const TABLES: { [K in Collection]-?: Table<K> } = {
  applicationAuthorityEnvelopes: table({
    name: "send_authorities",
    parse: (value) => ApplicationAuthorityEnvelopeSchema.parse(value),
    keys: (value) => [value.status],
    columns: ["status"],
  }),
  submissionPreflights: table({
    name: "send_preflights",
    once: true,
    parse: (value) => SubmissionPreflightRecordSchema.parse(value),
    keys: (value) => [value.idempotencyKey],
    columns: ["idempotency_key"],
  }),
  submissionExecutionGrants: table({
    name: "send_grants",
    parse: (value) => SubmissionExecutionGrantSchema.parse(value),
    keys: (value) => [value.preflightId, value.idempotencyKey],
    columns: ["preflight_id", "idempotency_key"],
  }),
  submissionIdempotencyRecords: table({
    name: "send_keys",
    parse: (value) => SubmissionIdempotencyRecordSchema.parse(value),
    keys: (value) => [value.idempotencyKey, value.preflightId],
    columns: ["idempotency_key", "preflight_id"],
  }),
  submissionArmedMarkers: table({
    name: "send_markers",
    once: true,
    parse: (value) => SubmissionArmedMarkerSchema.parse(value),
    keys: (value) => [value.idempotencyKey, value.preflightId],
    columns: ["idempotency_key", "preflight_id"],
  }),
  submissionOutcomeRecords: table({
    name: "send_outcomes",
    once: true,
    parse: (value) => SubmissionOutcomeRecordSchema.parse(value),
    keys: (value) => [value.jobId],
    columns: ["job_id"],
  }),
  applicationAnswerSnapshots: table({
    name: "answer_approvals",
    once: true,
    parse: (value) => ApprovedApplicationAnswerSnapshotSchema.parse(value),
    keys: (value) => [value.profileId, value.revision],
    columns: ["profile_id", "revision"],
  }),
};

export type SendGuards = ApplicationAuthorityRepository &
  ApplicationAnswerSnapshotRepository;

/**
 * The send guards over the job store. Each collection is read when the
 * guard first asks for it, every row checked against its schema, so a
 * changed or damaged row stops the guard instead of passing it. A change
 * runs in one immediate transaction and writes only the rows it changed.
 */
export function createSendGuards(store: JobStore): SendGuards {
  const { sql } = store;

  function load<K extends Collection>(key: K): Map<string, string> {
    const rows = sql(`SELECT id,value FROM ${TABLES[key].name} ORDER BY id`)
      .all()
      .map((row) => {
        const value = TABLES[key].parse(JSON.parse(String(row.value)));
        if (value.id !== row.id)
          throw new Error("A send record's id does not match its row.");
        return [value.id, JSON.stringify(value)] as const;
      });
    return new Map(rows);
  }

  /** The state with each collection loaded on first use. */
  function lazyState(loaded: Map<Collection, Map<string, string>>) {
    const values = new Map<Collection, unknown[]>();
    const state = {} as SendGuardState;
    for (const key of Object.keys(TABLES) as Collection[]) {
      const read = () => {
        if (!values.has(key)) {
          const rows = load(key);
          loaded.set(key, rows);
          values.set(
            key,
            [...rows.values()].map((value) => JSON.parse(value) as unknown),
          );
        }
        return values.get(key)!;
      };
      Object.defineProperty(state, key, {
        enumerable: true,
        get: read,
        set(next: unknown[]) {
          read();
          values.set(key, next);
        },
      });
    }
    return state;
  }

  function write(
    key: Collection,
    before: Map<string, string>,
    after: readonly { id: string }[],
  ): void {
    // Each table parses and keys only its own rows.
    const spec = TABLES[key] as unknown as Omit<
      Table<Collection>,
      "parse" | "keys"
    > & {
      parse(value: unknown): { id: string; status?: string };
      keys(value: { id: string }): (string | number)[];
    };
    const ids = new Set(after.map((value) => value.id));
    if (ids.size !== after.length)
      throw new Error("Two send records share an id.");
    for (const id of before.keys())
      if (!ids.has(id))
        throw new Error("Send records are kept; none may be removed.");
    const changed = after
      .filter((value) => before.get(value.id) !== JSON.stringify(value))
      .map((value) => spec.parse(value))
      .filter((value) => before.get(value.id) !== JSON.stringify(value));
    if (spec.once && changed.some((value) => before.has(value.id)))
      throw new Error("A send record written once may not change.");
    // The one active authority is a unique index: the row leaving that
    // status is written before the row taking it.
    changed.sort(
      (left, right) =>
        Number(left.status === "active") - Number(right.status === "active"),
    );
    const columns = ["id", ...spec.columns, "value"];
    const upsert = sql(
      `INSERT INTO ${spec.name}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})
      ON CONFLICT(id) DO UPDATE SET ${columns
        .slice(1)
        .map((column) => `${column}=excluded.${column}`)
        .join(",")}`,
    );
    for (const value of changed)
      upsert.run(value.id, ...spec.keys(value), JSON.stringify(value));
  }

  const stateStore = {
    read: () => lazyState(new Map()),
    mutate<T>(operation: (state: SendGuardState) => T): T {
      return store.transaction(() => {
        const loaded = new Map<Collection, Map<string, string>>();
        const state = lazyState(loaded);
        const result = operation(state);
        for (const [key, before] of loaded)
          write(key, before, state[key] ?? []);
        return result;
      });
    },
  };
  return {
    ...createApplicationAuthorityRepositoryMethods(stateStore),
    ...createApplicationAnswerSnapshotRepositoryMethods(stateStore),
  };
}
