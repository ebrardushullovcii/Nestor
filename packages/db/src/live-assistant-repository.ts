import {
  InterviewLiveSessionSchema,
  InterviewSessionSummarySchema,
  InterviewWorkspaceSnapshotSchema,
  InterviewWorkspaceViewSchema,
  summarizeInterviewSession,
  type InterviewLiveSession,
  type InterviewWorkspaceSnapshot,
  type InterviewWorkspaceView,
} from "@nordri/contracts";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LiveAssistantRepository {
  // Canonical import/export intentionally processes every retained body.
  load(): Promise<InterviewWorkspaceSnapshot | null>;
  save(snapshot: InterviewWorkspaceSnapshot): Promise<void>;
  loadWorkspace(): Promise<InterviewWorkspaceView | null>;
  loadSession(sessionId: string): Promise<InterviewLiveSession | null>;
  saveWorkspace(
    snapshot: InterviewWorkspaceView,
    changedArchiveSessions?: readonly InterviewLiveSession[],
  ): Promise<void>;
  close(): Promise<void>;
}

export interface FileLiveAssistantRepositoryOptions {
  filePath: string;
}

const WorkspaceMetadataSchema = InterviewWorkspaceViewSchema.omit({
  activeSession: true,
  recentSessions: true,
});

// ADR 0040: read pre-rename snapshots, preserving the original legacy file.
function withCurrentModuleName(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "module" in value &&
    value.module === "interview-helper"
  ) {
    return { ...value, module: "live-assistant" };
  }
  return value;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
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

export function createFileLiveAssistantRepository(
  options: FileLiveAssistantRepositoryOptions,
): LiveAssistantRepository {
  const databasePath = `${options.filePath}.sqlite`;
  let databasePromise: Promise<DatabaseSync> | null = null;
  let previousWorkspace: InterviewWorkspaceView | null = null;
  let closed = false;

  function writeMetadata(
    database: DatabaseSync,
    snapshot: InterviewWorkspaceView,
  ) {
    const { activeSession } = snapshot;
    database
      .prepare(
        `INSERT INTO live_workspace (id, value, active_session_id)
      VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET
      value = excluded.value, active_session_id = excluded.active_session_id`,
      )
      .run(
        JSON.stringify(WorkspaceMetadataSchema.parse(snapshot)),
        activeSession?.id ?? null,
      );
  }

  function writeSession(
    database: DatabaseSync,
    session: InterviewLiveSession,
    archivePosition: number | null,
  ) {
    const normalized = InterviewLiveSessionSchema.parse(session);
    database
      .prepare(
        `INSERT INTO live_sessions (id, value, summary, archive_position)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value,
      summary = excluded.summary, archive_position = excluded.archive_position`,
      )
      .run(
        normalized.id,
        JSON.stringify(normalized),
        JSON.stringify(summarizeInterviewSession(normalized)),
        archivePosition,
      );
  }

  function replaceCanonical(
    database: DatabaseSync,
    snapshot: InterviewWorkspaceSnapshot,
  ) {
    const ids = new Set<string>();
    for (const session of [
      snapshot.activeSession,
      ...snapshot.recentSessions,
    ]) {
      if (!session) continue;
      if (ids.has(session.id))
        throw new Error(
          "Duplicate retained Live Assistant session id; original archive was preserved.",
        );
      ids.add(session.id);
    }
    transaction(database, () => {
      database.exec("DELETE FROM live_sessions");
      snapshot.recentSessions.forEach((session, index) =>
        writeSession(database, session, index),
      );
      if (snapshot.activeSession)
        writeSession(database, snapshot.activeSession, null);
      writeMetadata(database, snapshot);
    });
    previousWorkspace = null;
  }

  async function openDatabase(): Promise<DatabaseSync> {
    if (closed) throw new Error("Live Assistant repository is closed.");
    databasePromise ??= (async () => {
      await mkdir(path.dirname(options.filePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      try {
        await chmod(databasePath, 0o600);
        database.exec(`PRAGMA synchronous = FULL;
          CREATE TABLE IF NOT EXISTS live_workspace (
            id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, active_session_id TEXT
          );
          CREATE TABLE IF NOT EXISTS live_sessions (
            id TEXT PRIMARY KEY, value TEXT NOT NULL, summary TEXT NOT NULL, archive_position INTEGER
          );
          CREATE INDEX IF NOT EXISTS live_sessions_archive
            ON live_sessions (archive_position) WHERE archive_position IS NOT NULL;`);
        if (
          !database.prepare("SELECT id FROM live_workspace WHERE id = 1").get()
        ) {
          let raw: string | null = null;
          try {
            raw = await readFile(options.filePath, "utf8");
          } catch (error) {
            if (
              !(
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
          if (raw !== null) {
            // The complete migration and marker commit together. A failed
            // transaction leaves the untouched legacy file authoritative.
            const snapshot = InterviewWorkspaceSnapshotSchema.parse(
              withCurrentModuleName(JSON.parse(raw) as unknown),
            );
            replaceCanonical(database, snapshot);
          }
        }
        return database;
      } catch (error) {
        database.close();
        databasePromise = null;
        throw error;
      }
    })();
    return databasePromise;
  }

  function readSession(database: DatabaseSync, sessionId: string) {
    const row = database
      .prepare("SELECT value FROM live_sessions WHERE id = ?")
      .get(sessionId);
    return row
      ? InterviewLiveSessionSchema.parse(
          JSON.parse(String(row.value)) as unknown,
        )
      : null;
  }

  async function loadSession(sessionId: string) {
    return readSession(await openDatabase(), sessionId);
  }

  async function loadWorkspace(): Promise<InterviewWorkspaceView | null> {
    const database = await openDatabase();
    const row = database
      .prepare(
        "SELECT value, active_session_id FROM live_workspace WHERE id = 1",
      )
      .get();
    if (!row) return null;
    const metadata = WorkspaceMetadataSchema.parse(
      JSON.parse(String(row.value)) as unknown,
    );
    const recentSessions = database
      .prepare(
        `SELECT summary FROM live_sessions
      WHERE archive_position IS NOT NULL ORDER BY archive_position`,
      )
      .all()
      .map((entry) =>
        InterviewSessionSummarySchema.parse(
          JSON.parse(String(entry.summary)) as unknown,
        ),
      );
    const activeSession =
      row.active_session_id === null
        ? null
        : readSession(database, String(row.active_session_id));
    if (row.active_session_id !== null && !activeSession)
      throw new Error("Retained Live Assistant active session was not found.");
    const workspace = { ...metadata, activeSession, recentSessions };
    previousWorkspace ??= workspace;
    return workspace;
  }

  return {
    loadWorkspace,
    loadSession,
    async load() {
      const database = await openDatabase();
      // Read one consistent canonical archive without changing the live view's
      // index identity or yielding between individual session reads.
      return transaction(database, () => {
        const row = database
          .prepare(
            "SELECT value, active_session_id FROM live_workspace WHERE id = 1",
          )
          .get();
        if (!row) return null;
        const metadata = WorkspaceMetadataSchema.parse(
          JSON.parse(String(row.value)) as unknown,
        );
        const activeSession =
          row.active_session_id === null
            ? null
            : readSession(database, String(row.active_session_id));
        if (row.active_session_id !== null && !activeSession)
          throw new Error(
            "Retained Live Assistant active session was not found.",
          );
        const recentSessions = database
          .prepare(
            "SELECT value FROM live_sessions WHERE archive_position IS NOT NULL ORDER BY archive_position",
          )
          .all()
          .map((entry) =>
            InterviewLiveSessionSchema.parse(
              JSON.parse(String(entry.value)) as unknown,
            ),
          );
        return { ...metadata, activeSession, recentSessions };
      });
    },
    async save(snapshot) {
      const normalized = InterviewWorkspaceSnapshotSchema.parse(snapshot);
      replaceCanonical(await openDatabase(), normalized);
    },
    async saveWorkspace(snapshot, changedArchiveSessions = []) {
      const database = await openDatabase();
      if (!previousWorkspace) await loadWorkspace();
      const previous = previousWorkspace;
      const archiveChanged =
        previous?.recentSessions !== snapshot.recentSessions;
      const positions = archiveChanged
        ? new Map(
            snapshot.recentSessions.map((session, index) => [
              session.id,
              index,
            ]),
          )
        : null;
      if (positions && positions.size !== snapshot.recentSessions.length) {
        throw new Error(
          "Duplicate retained Live Assistant session id; original archive was preserved.",
        );
      }
      transaction(database, () => {
        if (archiveChanged) {
          for (const session of previous?.recentSessions ?? []) {
            if (!positions?.has(session.id))
              database
                .prepare("DELETE FROM live_sessions WHERE id = ?")
                .run(session.id);
          }
          snapshot.recentSessions.forEach((summary, index) => {
            // Reorder only the index. Historical bodies are never read or written.
            database
              .prepare(
                "UPDATE live_sessions SET archive_position = ?, summary = ? WHERE id = ?",
              )
              .run(
                index,
                JSON.stringify(InterviewSessionSummarySchema.parse(summary)),
                summary.id,
              );
          });
        }
        for (const session of changedArchiveSessions) {
          const index = snapshot.recentSessions.findIndex(
            (summary) => summary.id === session.id,
          );
          if (index < 0)
            throw new Error(
              "Changed archive session is missing from the workspace index.",
            );
          writeSession(database, session, index);
        }
        if (
          snapshot.activeSession &&
          snapshot.activeSession !== previous?.activeSession
        )
          writeSession(database, snapshot.activeSession, null);
        if (archiveChanged) {
          for (const summary of snapshot.recentSessions) {
            if (
              summary.id === snapshot.activeSession?.id ||
              !database
                .prepare("SELECT id FROM live_sessions WHERE id = ?")
                .get(summary.id)
            ) {
              throw new Error(
                "Archive index requires a separate retained session body.",
              );
            }
          }
        }
        if (
          previous?.activeSession &&
          previous.activeSession.id !== snapshot.activeSession?.id &&
          !snapshot.recentSessions.some(
            (summary) => summary.id === previous.activeSession?.id,
          )
        ) {
          database
            .prepare("DELETE FROM live_sessions WHERE id = ?")
            .run(previous.activeSession.id);
        }
        writeMetadata(database, snapshot);
      });
      previousWorkspace = snapshot;
    },
    async close() {
      if (closed) return;
      const database = databasePromise ? await databasePromise : null;
      database?.close();
      closed = true;
    },
  };
}
