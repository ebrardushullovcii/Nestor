/* eslint-disable @typescript-eslint/require-await -- node:sqlite is synchronous; the methods stay async to match the repository interface other stores implement. */
import {
  AssistantChangeReceiptSchema,
  AssistantCheckpointSchema,
  AssistantConversationSchema,
  AssistantEventPayloadSchema,
  AssistantEventSchema,
  AssistantInstructionGrantSchema,
  AssistantMessageSchema,
  AssistantOperationSchema,
  AssistantProposalSchema,
  AssistantResultSetSchema,
  AssistantTabLeaseSchema,
  AssistantTaskPlanSchema,
  AssistantTurnSchema,
  type AssistantChangeReceipt,
  type AssistantCheckpoint,
  type AssistantConversation,
  type AssistantEvent,
  type AssistantEventPayload,
  type AssistantInstructionGrant,
  type AssistantMessage,
  type AssistantOperation,
  type AssistantProposal,
  type AssistantResultSet,
  type AssistantTabLease,
  type AssistantTaskPlan,
  type AssistantTurn,
  type AssistantTurnStatus,
} from "@nestor/contracts";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";


/**
 * Storage for the app assistant (ADR 0037): conversations the person sees,
 * the task state the assistant works from, and the raw model tail that keeps
 * a conversation continuous. It lives in its own SQLite file beside the
 * workspace database: nothing here is workspace truth, and a damaged
 * assistant store can never block the workspace from opening.
 */

/** One stored model message, kept verbatim for the next call's tail. */
export interface AssistantTranscriptItem {
  seq: number;
  turnId: string;
  /** JSON of one model message (system prompts are never stored). */
  message: unknown;
  createdAt: string;
}

export interface AssistantRepository {
  listConversations(): Promise<AssistantConversation[]>;
  getConversation(id: string): Promise<AssistantConversation | null>;
  upsertConversation(conversation: AssistantConversation): Promise<void>;
  /** Removes the conversation and every record that belongs to it. */
  deleteConversation(id: string): Promise<void>;
  getCurrentConversationId(): Promise<string | null>;
  setCurrentConversationId(id: string | null): Promise<void>;

  listMessages(
    conversationId: string,
    options?: { beforeMessageId?: string | null; limit?: number },
  ): Promise<{ messages: AssistantMessage[]; hasOlder: boolean }>;
  getMessage(id: string): Promise<AssistantMessage | null>;
  findMessageByClientId(
    conversationId: string,
    clientMessageId: string,
  ): Promise<AssistantMessage | null>;
  findMigratedMessage(
    source: "profile_copilot",
    legacyId: string,
  ): Promise<AssistantMessage | null>;
  upsertMessage(message: AssistantMessage): Promise<void>;
  countMessages(conversationId: string): Promise<number>;

  addPendingMessage(conversationId: string, messageId: string): Promise<void>;
  listPendingMessageIds(conversationId: string): Promise<string[]>;
  removePendingMessages(
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<void>;

  upsertTurn(turn: AssistantTurn): Promise<void>;
  getTurn(id: string): Promise<AssistantTurn | null>;
  listTurns(
    conversationId: string,
    options?: { limit?: number },
  ): Promise<AssistantTurn[]>;
  listTurnsByStatus(
    statuses: readonly AssistantTurnStatus[],
  ): Promise<AssistantTurn[]>;

  appendEvent(input: {
    conversationId: string;
    turnId: string | null;
    payload: AssistantEventPayload;
    at?: string;
  }): Promise<AssistantEvent>;
  listEvents(
    conversationId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<AssistantEvent[]>;
  getLastSequence(conversationId: string): Promise<number>;
  pruneEvents(conversationId: string, keepLast: number): Promise<void>;

  upsertOperation(operation: AssistantOperation): Promise<void>;
  getOperation(id: string): Promise<AssistantOperation | null>;
  findOperationByArguments(input: {
    conversationId: string;
    turnId: string;
    toolName: string;
    argumentsHash: string;
  }): Promise<AssistantOperation | null>;
  listOperations(
    conversationId: string,
    options?: { runOnly?: boolean },
  ): Promise<AssistantOperation[]>;

  upsertChangeReceipt(receipt: AssistantChangeReceipt): Promise<void>;
  getChangeReceipt(id: string): Promise<AssistantChangeReceipt | null>;
  listChangeReceipts(conversationId: string): Promise<AssistantChangeReceipt[]>;

  upsertGrant(grant: AssistantInstructionGrant): Promise<void>;
  getGrant(id: string): Promise<AssistantInstructionGrant | null>;
  listGrants(conversationId?: string): Promise<AssistantInstructionGrant[]>;

  upsertPlan(plan: AssistantTaskPlan): Promise<void>;
  getPlan(id: string): Promise<AssistantTaskPlan | null>;
  listPlans(options?: {
    conversationId?: string;
    status?: AssistantTaskPlan["status"];
  }): Promise<AssistantTaskPlan[]>;

  upsertProposal(proposal: AssistantProposal): Promise<void>;
  getProposal(id: string): Promise<AssistantProposal | null>;
  listProposals(conversationId: string): Promise<AssistantProposal[]>;

  upsertResultSet(resultSet: AssistantResultSet): Promise<void>;
  getResultSet(id: string): Promise<AssistantResultSet | null>;
  listResultSets(conversationId: string): Promise<AssistantResultSet[]>;

  appendCheckpoint(checkpoint: AssistantCheckpoint): Promise<void>;
  getLatestCheckpoint(
    conversationId: string,
  ): Promise<AssistantCheckpoint | null>;

  upsertLease(lease: AssistantTabLease): Promise<void>;
  listLeases(options?: {
    status?: AssistantTabLease["status"];
    conversationId?: string;
  }): Promise<AssistantTabLease[]>;

  appendTranscript(
    conversationId: string,
    turnId: string,
    messages: readonly unknown[],
  ): Promise<void>;
  listTranscript(
    conversationId: string,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<AssistantTranscriptItem[]>;
  /** Replaces stored tail items (compaction layer 1 rewrites old tool output). */
  replaceTranscriptItems(
    conversationId: string,
    items: readonly { seq: number; message: unknown }[],
  ): Promise<void>;

  /** Removes everything; used by workspace reset. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface AssistantRepositoryOptions {
  /** `:memory:` keeps everything in process (tests, deterministic harnesses). */
  filePath: string;
  now?: () => string;
}

type RecordKind =
  | "conversation"
  | "message"
  | "turn"
  | "operation"
  | "receipt"
  | "grant"
  | "plan"
  | "result_set"
  | "proposal"
  | "checkpoint"
  | "lease";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS assistant_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT,
  sort_key TEXT NOT NULL,
  status TEXT,
  lookup TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS assistant_records_conversation
  ON assistant_records (kind, conversation_id, sort_key);
CREATE INDEX IF NOT EXISTS assistant_records_lookup
  ON assistant_records (kind, lookup);
CREATE INDEX IF NOT EXISTS assistant_records_status
  ON assistant_records (kind, status);
CREATE TABLE IF NOT EXISTS assistant_events (
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (conversation_id, sequence)
);
CREATE TABLE IF NOT EXISTS assistant_pending (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);
CREATE TABLE IF NOT EXISTS assistant_transcript (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE TABLE IF NOT EXISTS assistant_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const CURRENT_CONVERSATION_KEY = "current_conversation_id";

interface RecordRow {
  data: string;
}

function parseRow<T>(_schema: { parse(value: unknown): T }, row: unknown): T {
  const data = (row as RecordRow).data;
  // Every writer and history import validates before storing these app-owned rows.
  return JSON.parse(data) as T;
}

export function createAssistantRepository(
  options: AssistantRepositoryOptions,
): AssistantRepository {
  const inMemory = options.filePath === ":memory:";
  if (!inMemory) {
    mkdirSync(path.dirname(options.filePath), { recursive: true });
  }
  const database = new DatabaseSync(options.filePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA_SQL);
  if (!inMemory && process.platform !== "win32") {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(`${options.filePath}${suffix}`, 0o600);
      } catch {
        // The -wal and -shm files appear on first write.
      }
    }
  }
  const now = options.now ?? (() => new Date().toISOString());
  let closed = false;

  function transaction<T>(operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function putRecord(input: {
    kind: RecordKind;
    id: string;
    conversationId: string | null;
    sortKey: string;
    status?: string | null;
    lookup?: string | null;
    data: unknown;
  }): void {
    database
      .prepare(
        `INSERT INTO assistant_records (kind, id, conversation_id, sort_key, status, lookup, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           sort_key = excluded.sort_key,
           status = excluded.status,
           lookup = excluded.lookup,
           data = excluded.data`,
      )
      .run(
        input.kind,
        input.id,
        input.conversationId,
        input.sortKey,
        input.status ?? null,
        input.lookup ?? null,
        JSON.stringify(input.data),
      );
  }

  function getRecord<T>(
    kind: RecordKind,
    id: string,
    schema: { parse(value: unknown): T },
  ): T | null {
    const row = database
      .prepare(`SELECT data FROM assistant_records WHERE kind = ? AND id = ?`)
      .get(kind, id);
    return row ? parseRow(schema, row) : null;
  }

  function listRecords<T>(
    kind: RecordKind,
    schema: { parse(value: unknown): T },
    where: { conversationId?: string; status?: string; lookup?: string } = {},
    order: "ASC" | "DESC" = "ASC",
    limit?: number,
  ): T[] {
    const clauses = ["kind = ?"];
    const params: (string | number)[] = [kind];
    if (where.conversationId !== undefined) {
      clauses.push("conversation_id = ?");
      params.push(where.conversationId);
    }
    if (where.status !== undefined) {
      clauses.push("status = ?");
      params.push(where.status);
    }
    if (where.lookup !== undefined) {
      clauses.push("lookup = ?");
      params.push(where.lookup);
    }
    const limitClause =
      typeof limit === "number"
        ? ` LIMIT ${Math.max(1, Math.floor(limit))}`
        : "";
    return database
      .prepare(
        `SELECT data FROM assistant_records WHERE ${clauses.join(" AND ")}
         ORDER BY sort_key ${order}, id ${order}${limitClause}`,
      )
      .all(...params)
      .map((row) => parseRow(schema, row));
  }

  const repository: AssistantRepository = {
    async listConversations() {
      return listRecords(
        "conversation",
        AssistantConversationSchema,
        {},
        "DESC",
      );
    },
    async getConversation(id) {
      return getRecord("conversation", id, AssistantConversationSchema);
    },
    async upsertConversation(conversation) {
      const parsed = AssistantConversationSchema.parse(conversation);
      putRecord({
        kind: "conversation",
        id: parsed.id,
        conversationId: parsed.id,
        sortKey: parsed.lastMessageAt ?? parsed.updatedAt,
        status: parsed.status,
        lookup: parsed.jobId,
        data: parsed,
      });
    },
    async deleteConversation(id) {
      transaction(() => {
        database
          .prepare(
            `DELETE FROM assistant_records WHERE conversation_id = ? OR (kind = 'conversation' AND id = ?)`,
          )
          .run(id, id);
        database
          .prepare(`DELETE FROM assistant_events WHERE conversation_id = ?`)
          .run(id);
        database
          .prepare(`DELETE FROM assistant_pending WHERE conversation_id = ?`)
          .run(id);
        database
          .prepare(`DELETE FROM assistant_transcript WHERE conversation_id = ?`)
          .run(id);
        const current = database
          .prepare(`SELECT value FROM assistant_meta WHERE key = ?`)
          .get(CURRENT_CONVERSATION_KEY) as
          | { value: string | null }
          | undefined;
        if (current?.value === id) {
          database
            .prepare(`DELETE FROM assistant_meta WHERE key = ?`)
            .run(CURRENT_CONVERSATION_KEY);
        }
      });
    },
    async getCurrentConversationId() {
      const row = database
        .prepare(`SELECT value FROM assistant_meta WHERE key = ?`)
        .get(CURRENT_CONVERSATION_KEY) as { value: string | null } | undefined;
      return row?.value ?? null;
    },
    async setCurrentConversationId(id) {
      if (id === null) {
        database
          .prepare(`DELETE FROM assistant_meta WHERE key = ?`)
          .run(CURRENT_CONVERSATION_KEY);
        return;
      }
      database
        .prepare(
          `INSERT INTO assistant_meta (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(CURRENT_CONVERSATION_KEY, id);
    },

    async listMessages(conversationId, listOptions = {}) {
      const limit = Math.max(1, Math.min(400, listOptions.limit ?? 200));
      let beforeKey: string | null = null;
      if (listOptions.beforeMessageId) {
        const row = database
          .prepare(
            `SELECT sort_key FROM assistant_records WHERE kind = 'message' AND id = ?`,
          )
          .get(listOptions.beforeMessageId) as { sort_key: string } | undefined;
        beforeKey = row?.sort_key ?? null;
      }
      const rows = database
        .prepare(
          `SELECT data FROM assistant_records
           WHERE kind = 'message' AND conversation_id = ?
           ${beforeKey ? "AND sort_key < ?" : ""}
           ORDER BY sort_key DESC LIMIT ?`,
        )
        .all(
          ...(beforeKey
            ? [conversationId, beforeKey, limit + 1]
            : [conversationId, limit + 1]),
        );
      const hasOlder = rows.length > limit;
      const messages = rows
        .slice(0, limit)
        .map((row) => parseRow(AssistantMessageSchema, row))
        .reverse();
      return { messages, hasOlder };
    },
    async getMessage(id) {
      return getRecord("message", id, AssistantMessageSchema);
    },
    async findMessageByClientId(conversationId, clientMessageId) {
      return (
        listRecords("message", AssistantMessageSchema, {
          conversationId,
          lookup: `client:${clientMessageId}`,
        })[0] ?? null
      );
    },
    async findMigratedMessage(source, legacyId) {
      return (
        listRecords("message", AssistantMessageSchema, {
          lookup: `migrated:${source}:${legacyId}`,
        })[0] ?? null
      );
    },
    async upsertMessage(message) {
      const parsed = AssistantMessageSchema.parse(message);
      // Sort by creation time, then id, with a zero-padded tiebreak so two
      // messages written in the same millisecond keep their order.
      putRecord({
        kind: "message",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.createdAt}|${parsed.id}`,
        status: parsed.role,
        lookup: parsed.migratedFrom
          ? `migrated:${parsed.migratedFrom.source}:${parsed.migratedFrom.legacyId}`
          : parsed.clientMessageId
            ? `client:${parsed.clientMessageId}`
            : null,
        data: parsed,
      });
    },
    async countMessages(conversationId) {
      const row = database
        .prepare(
          `SELECT COUNT(*) AS count FROM assistant_records WHERE kind = 'message' AND conversation_id = ?`,
        )
        .get(conversationId) as { count: number };
      return Number(row.count);
    },

    async addPendingMessage(conversationId, messageId) {
      database
        .prepare(
          `INSERT OR IGNORE INTO assistant_pending (conversation_id, message_id, created_at) VALUES (?, ?, ?)`,
        )
        .run(conversationId, messageId, now());
    },
    async listPendingMessageIds(conversationId) {
      return database
        .prepare(
          `SELECT message_id FROM assistant_pending WHERE conversation_id = ? ORDER BY created_at ASC, message_id ASC`,
        )
        .all(conversationId)
        .map((row) => String((row as { message_id: string }).message_id));
    },
    async removePendingMessages(conversationId, messageIds) {
      if (messageIds.length === 0) return;
      transaction(() => {
        const statement = database.prepare(
          `DELETE FROM assistant_pending WHERE conversation_id = ? AND message_id = ?`,
        );
        for (const messageId of messageIds) {
          statement.run(conversationId, messageId);
        }
      });
    },

    async upsertTurn(turn) {
      const parsed = AssistantTurnSchema.parse(turn);
      putRecord({
        kind: "turn",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.startedAt}|${parsed.id}`,
        status: parsed.status,
        data: parsed,
      });
    },
    async getTurn(id) {
      return getRecord("turn", id, AssistantTurnSchema);
    },
    async listTurns(conversationId, listOptions = {}) {
      return listRecords(
        "turn",
        AssistantTurnSchema,
        { conversationId },
        "DESC",
        listOptions.limit ?? 50,
      ).reverse();
    },
    async listTurnsByStatus(statuses) {
      return statuses.flatMap((status) =>
        listRecords("turn", AssistantTurnSchema, { status }),
      );
    },

    async appendEvent(input) {
      const payload = AssistantEventPayloadSchema.parse(input.payload);
      return transaction(() => {
        const row = database
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) AS last FROM assistant_events WHERE conversation_id = ?`,
          )
          .get(input.conversationId) as { last: number };
        const lastMeta = database
          .prepare(`SELECT value FROM assistant_meta WHERE key = ?`)
          .get(`last_sequence:${input.conversationId}`) as
          | { value: string }
          | undefined;
        // Pruned events must never let a sequence number be reused.
        const last = Math.max(
          Number(row.last),
          Number.parseInt(lastMeta?.value ?? "0", 10) || 0,
        );
        const event = AssistantEventSchema.parse({
          conversationId: input.conversationId,
          sequence: last + 1,
          turnId: input.turnId,
          at: input.at ?? now(),
          payload,
        });
        database
          .prepare(
            `INSERT INTO assistant_events (conversation_id, sequence, data) VALUES (?, ?, ?)`,
          )
          .run(event.conversationId, event.sequence, JSON.stringify(event));
        database
          .prepare(
            `INSERT INTO assistant_meta (key, value) VALUES (?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          )
          .run(`last_sequence:${input.conversationId}`, String(event.sequence));
        return event;
      });
    },
    async listEvents(conversationId, afterSequence, limit = 500) {
      return database
        .prepare(
          `SELECT data FROM assistant_events WHERE conversation_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(conversationId, afterSequence, Math.max(1, limit))
        .map((row) => parseRow(AssistantEventSchema, row));
    },
    async getLastSequence(conversationId) {
      const row = database
        .prepare(`SELECT value FROM assistant_meta WHERE key = ?`)
        .get(`last_sequence:${conversationId}`) as
        | { value: string }
        | undefined;
      return Number.parseInt(row?.value ?? "0", 10) || 0;
    },
    async pruneEvents(conversationId, keepLast) {
      database
        .prepare(
          `DELETE FROM assistant_events WHERE conversation_id = ? AND sequence <= (
             SELECT COALESCE(MAX(sequence), 0) - ? FROM assistant_events WHERE conversation_id = ?
           )`,
        )
        .run(conversationId, Math.max(0, keepLast), conversationId);
    },

    async upsertOperation(operation) {
      const parsed = AssistantOperationSchema.parse(operation);
      putRecord({
        kind: "operation",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.startedAt}|${parsed.id}`,
        status: parsed.status,
        lookup: `${parsed.turnId}|${parsed.toolName}|${parsed.argumentsHash}`,
        data: parsed,
      });
    },
    async getOperation(id) {
      return getRecord("operation", id, AssistantOperationSchema);
    },
    async findOperationByArguments(input) {
      return (
        listRecords("operation", AssistantOperationSchema, {
          conversationId: input.conversationId,
          lookup: `${input.turnId}|${input.toolName}|${input.argumentsHash}`,
        }).at(-1) ?? null
      );
    },
    async listOperations(conversationId, listOptions = {}) {
      const operations = listRecords("operation", AssistantOperationSchema, {
        conversationId,
      });
      return listOptions.runOnly
        ? operations.filter((operation) => operation.run !== null)
        : operations;
    },

    async upsertChangeReceipt(receipt) {
      const parsed = AssistantChangeReceiptSchema.parse(receipt);
      putRecord({
        kind: "receipt",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.createdAt}|${parsed.id}`,
        status: parsed.status,
        lookup: parsed.targetId,
        data: parsed,
      });
    },
    async getChangeReceipt(id) {
      return getRecord("receipt", id, AssistantChangeReceiptSchema);
    },
    async listChangeReceipts(conversationId) {
      return listRecords("receipt", AssistantChangeReceiptSchema, {
        conversationId,
      });
    },

    async upsertGrant(grant) {
      const parsed = AssistantInstructionGrantSchema.parse(grant);
      putRecord({
        kind: "grant",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.createdAt}|${parsed.id}`,
        status: parsed.status,
        lookup: parsed.sourceMessageId,
        data: parsed,
      });
    },
    async getGrant(id) {
      return getRecord("grant", id, AssistantInstructionGrantSchema);
    },
    async listGrants(conversationId) {
      return listRecords(
        "grant",
        AssistantInstructionGrantSchema,
        conversationId === undefined ? {} : { conversationId },
      );
    },

    async upsertPlan(plan) {
      const parsed = AssistantTaskPlanSchema.parse(plan);
      putRecord({
        kind: "plan",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.createdAt}|${parsed.id}`,
        status: parsed.status,
        data: parsed,
      });
    },
    async getPlan(id) {
      return getRecord("plan", id, AssistantTaskPlanSchema);
    },
    async listPlans(listOptions = {}) {
      return listRecords("plan", AssistantTaskPlanSchema, {
        ...(listOptions.conversationId !== undefined
          ? { conversationId: listOptions.conversationId }
          : {}),
        ...(listOptions.status !== undefined
          ? { status: listOptions.status }
          : {}),
      });
    },

    async upsertProposal(proposal) {
      const parsed = AssistantProposalSchema.parse(proposal);
      putRecord({
        kind: "proposal",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.createdAt}|${parsed.id}`,
        status: parsed.status,
        data: parsed,
      });
    },
    async getProposal(id) {
      return getRecord("proposal", id, AssistantProposalSchema);
    },
    async listProposals(conversationId) {
      return listRecords("proposal", AssistantProposalSchema, {
        conversationId,
      });
    },

    async upsertResultSet(resultSet) {
      const parsed = AssistantResultSetSchema.parse(resultSet);
      putRecord({
        kind: "result_set",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.createdAt}|${parsed.id}`,
        data: parsed,
      });
    },
    async getResultSet(id) {
      return getRecord("result_set", id, AssistantResultSetSchema);
    },
    async listResultSets(conversationId) {
      return listRecords("result_set", AssistantResultSetSchema, {
        conversationId,
      });
    },

    async appendCheckpoint(checkpoint) {
      const parsed = AssistantCheckpointSchema.parse(checkpoint);
      putRecord({
        kind: "checkpoint",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: String(parsed.version).padStart(8, "0"),
        data: parsed,
      });
    },
    async getLatestCheckpoint(conversationId) {
      return (
        listRecords(
          "checkpoint",
          AssistantCheckpointSchema,
          { conversationId },
          "DESC",
          1,
        )[0] ?? null
      );
    },

    async upsertLease(lease) {
      const parsed = AssistantTabLeaseSchema.parse(lease);
      putRecord({
        kind: "lease",
        id: parsed.id,
        conversationId: parsed.conversationId,
        sortKey: `${parsed.createdAt}|${parsed.id}`,
        status: parsed.status,
        lookup: parsed.tabId,
        data: parsed,
      });
    },
    async listLeases(listOptions = {}) {
      return listRecords("lease", AssistantTabLeaseSchema, {
        ...(listOptions.status !== undefined
          ? { status: listOptions.status }
          : {}),
        ...(listOptions.conversationId !== undefined
          ? { conversationId: listOptions.conversationId }
          : {}),
      });
    },

    async appendTranscript(conversationId, turnId, messages) {
      if (messages.length === 0) return;
      transaction(() => {
        const row = database
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS last FROM assistant_transcript WHERE conversation_id = ?`,
          )
          .get(conversationId) as { last: number };
        let seq = Number(row.last);
        const statement = database.prepare(
          `INSERT INTO assistant_transcript (conversation_id, seq, turn_id, created_at, data) VALUES (?, ?, ?, ?, ?)`,
        );
        const createdAt = now();
        for (const message of messages) {
          seq += 1;
          statement.run(
            conversationId,
            seq,
            turnId,
            createdAt,
            JSON.stringify(message),
          );
        }
      });
    },
    async listTranscript(conversationId, listOptions = {}) {
      const rows = database
        .prepare(
          `SELECT seq, turn_id, created_at, data FROM assistant_transcript
           WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        )
        .all(
          conversationId,
          listOptions.afterSeq ?? 0,
          Math.max(1, listOptions.limit ?? 5_000),
        ) as {
        seq: number;
        turn_id: string;
        created_at: string;
        data: string;
      }[];
      return rows.map((row) => ({
        seq: Number(row.seq),
        turnId: row.turn_id,
        createdAt: row.created_at,
        message: JSON.parse(row.data) as unknown,
      }));
    },
    async replaceTranscriptItems(conversationId, items) {
      if (items.length === 0) return;
      transaction(() => {
        const statement = database.prepare(
          `UPDATE assistant_transcript SET data = ? WHERE conversation_id = ? AND seq = ?`,
        );
        for (const item of items) {
          statement.run(JSON.stringify(item.message), conversationId, item.seq);
        }
      });
    },

    async reset() {
      transaction(() => {
        database.exec(`DELETE FROM assistant_records`);
        database.exec(`DELETE FROM assistant_events`);
        database.exec(`DELETE FROM assistant_pending`);
        database.exec(`DELETE FROM assistant_transcript`);
        database.exec(`DELETE FROM assistant_meta`);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };

  return repository;
}
