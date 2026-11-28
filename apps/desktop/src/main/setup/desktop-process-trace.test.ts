import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { registerDesktopProcessTrace } from "./desktop-process-trace";

test("a traced desktop run records process starts, failures and ordinary exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "nestor-process-trace-"));
  const app = new EventEmitter();
  const desktopProcess = Object.assign(new EventEmitter(), {
    pid: process.pid,
  });
  try {
    vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
    registerDesktopProcessTrace(app, desktopProcess);

    desktopProcess.emit(
      "uncaughtExceptionMonitor",
      Error("Synthetic failure"),
      "uncaughtException",
    );
    app.emit(
      "render-process-gone",
      {},
      { id: 7 },
      { reason: "oom", exitCode: 9 },
    );
    app.emit(
      "child-process-gone",
      {},
      { type: "GPU", reason: "crashed", exitCode: 11 },
    );
    desktopProcess.emit("exit", 1);

    const events = readFileSync(
      join(dir, `events-${process.pid}.jsonl`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(events).toMatchObject([
      { event: "desktop_process_started", pid: process.pid },
      {
        event: "desktop_process_exception",
        error: { message: "Synthetic failure" },
        origin: "uncaughtException",
      },
      {
        event: "desktop_renderer_gone",
        webContentsId: 7,
        reason: "oom",
        exitCode: 9,
      },
      {
        event: "desktop_child_process_gone",
        type: "GPU",
        reason: "crashed",
        exitCode: 11,
      },
      { event: "desktop_process_exit", code: 1 },
    ]);
    expect(desktopProcess.listenerCount("uncaughtException")).toBe(0);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
