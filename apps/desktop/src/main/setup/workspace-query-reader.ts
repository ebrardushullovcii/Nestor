import {
  createWorkspaceQueryRepository,
  type WorkspaceQueryRepository,
} from "@nestor/db";
import {
  WorkspaceQueryPortRequestSchema,
  type WorkspaceQueryPortMessage,
  type WorkspaceReaderControl,
  type WorkspaceReadRequest,
} from "@nestor/contracts";

const parent = process.parentPort;
if (!parent) throw new Error("Workspace reads require a utility process.");
const ports = new Set<Electron.MessagePortMain>();
let filePath = "";
let repository: WorkspaceQueryRepository | undefined;
let cursor = 0;
let resolveContext!: () => void;
let resolveQueries!: () => void;
const contextReady = new Promise<void>((resolve) => {
  resolveContext = resolve;
});
const queriesReady = new Promise<void>((resolve) => {
  resolveQueries = resolve;
});

function read(request: WorkspaceReadRequest) {
  if (request.method === "setQueryUpdates")
    throw new Error("Query update mode belongs to the main window.");
  if (!repository) {
    repository = createWorkspaceQueryRepository(filePath);
    cursor = repository.getChanges(Number.MAX_SAFE_INTEGER).revision;
  }
  switch (request.method) {
    case "getStartupContext":
      return repository.getStartupContext();
    case "queryJobList":
      return repository.queryJobList(request.input);
    case "getJobDetail":
      return repository.getJobDetail(request.input.jobId, request.input.planId);
    case "getCompanyDetail":
      return repository.getCompanyDetail(request.input.companyId);
    case "getListCounts":
      return repository.getListCounts(request.input);
    case "queryCompanies":
      return repository.queryCompanies(request.input);
    case "getChanges":
      return repository.getChanges(request.input.after, request.input.limit);
  }
}
function send(
  port: Electron.MessagePortMain,
  message: WorkspaceQueryPortMessage,
) {
  if (ports.has(port)) port.postMessage(message);
}
function pushChanges() {
  if (!repository) return;
  const batch = repository.getChanges(cursor);
  if (!batch.changes.length) return;
  for (const port of ports) send(port, { type: "changes", value: batch });
  cursor = batch.revision;
  if (batch.hasMore) setImmediate(pushChanges);
}
parent.on("message", (event) => {
  const message = event.data as WorkspaceReaderControl;
  switch (message.type) {
    case "initialize":
      filePath = message.filePath;
      break;
    case "context-ready":
      resolveContext();
      break;
    case "queries-ready":
      resolveQueries();
      break;
    case "changed":
      pushChanges();
      break;
    case "close":
      for (const port of ports) port.close();
      repository?.close();
      process.exit(0);
      break;
    case "attach": {
      const port = event.ports[0];
      if (!port) break;
      ports.add(port);
      port.on("close", () => ports.delete(port));
      port.on("message", (requestEvent) => {
        const data: unknown = requestEvent.data;
        const parsed = WorkspaceQueryPortRequestSchema.safeParse(data);
        if (!parsed.success) {
          const id = WorkspaceQueryPortRequestSchema.shape.id.safeParse(
            typeof data === "object" && data !== null && "id" in data
              ? data.id
              : null,
          );
          if (id.success)
            send(port, {
              type: "reply",
              id: id.data,
              ok: false,
              error: "Invalid workspace query.",
            });
          return;
        }
        const { id, request } = parsed.data;
        // Post the result in the gate's continuation. An extra async read/then
        // hop let a later page build delay an already-computed Home reply.
        void (
          request.method === "getStartupContext" ? contextReady : queriesReady
        )
          .then(() => {
            const value = read(request);
            send(port, { type: "reply", id, ok: true, value });
            pushChanges();
          })
          .catch((error: unknown) =>
            send(port, {
              type: "reply",
              id,
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Workspace read failed.",
            }),
          );
      });
      port.start();
      break;
    }
  }
});
