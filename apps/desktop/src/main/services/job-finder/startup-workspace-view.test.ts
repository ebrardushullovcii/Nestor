import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { deserialize, serialize } from "node:v8";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  directory: "",
  database: null as string | null,
}));

vi.mock("./paths", () => ({
  getJobFinderUserDataDirectory: () => state.directory,
  getJobFinderWorkspaceFilePath: () =>
    path.join(state.directory, "job-finder-workspace.sqlite"),
}));
vi.mock("@nestor/db", () => ({
  readCleanCloseFingerprint: () => state.database,
}));

function view(label: string) {
  return {
    bootstrap: {
      hydration: { phase: "bootstrap" },
      label,
    } as unknown as JobFinderRendererWorkspaceSnapshot,
    snapshot: {
      hydration: { phase: "complete" },
      label,
    } as unknown as JobFinderRendererWorkspaceSnapshot,
  };
}

async function freshModule() {
  vi.resetModules();
  return import("./startup-workspace-view");
}

describe("startup workspace view", () => {
  beforeEach(() => {
    state.directory = mkdtempSync(path.join(tmpdir(), "startup-view-"));
    state.database = "db-print-1";
  });
  afterEach(() => {
    rmSync(state.directory, { recursive: true, force: true });
  });

  it("serves the view a clean close saved, once, on the next start", async () => {
    (await freshModule()).writeStartupWorkspaceView(view("saved"));

    const next = await freshModule();
    next.captureStartupWorkspaceView();

    expect(next.takeStartupBootstrap()).toMatchObject({ label: "saved" });
    expect(next.takeStartupSnapshot()).toMatchObject({ label: "saved" });
    expect(next.takeStartupSnapshot()).toBeNull();
    expect(
      existsSync(path.join(state.directory, "job-finder-startup-view.bin")),
    ).toBe(false);
  });

  it("ignores a view when the database changed since the close", async () => {
    (await freshModule()).writeStartupWorkspaceView(view("saved"));
    state.database = "db-print-2";

    const next = await freshModule();
    next.captureStartupWorkspaceView();

    expect(next.takeStartupBootstrap()).toBeNull();
    expect(next.takeStartupSnapshot()).toBeNull();
  });

  it("lets the full saved view reach the window before canonical startup", async () => {
    (await freshModule()).writeStartupWorkspaceView(view("saved"));
    const next = await freshModule();
    next.captureStartupWorkspaceView();
    let ready = false;
    const waiting = next.waitForSavedStartupWorkspace()!.then(() => {
      ready = true;
    });
    next.noteStartupWorkspaceRevisionHeld(); // bootstrap acknowledgement
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(next.takeStartupSnapshot()).toMatchObject({ label: "saved" });
    next.noteStartupWorkspaceSnapshotSent();
    await Promise.resolve();
    expect(ready).toBe(false);
    next.noteStartupWorkspaceRevisionHeld();
    await waiting;
    expect(ready).toBe(true);
  });

  it.each(["bootstrap", "snapshot"] as const)(
    "falls back immediately when the saved %s cannot be decoded",
    async (field) => {
      (await freshModule()).writeStartupWorkspaceView(view("saved"));
      const file = path.join(state.directory, "job-finder-startup-view.bin");
      const stored = deserialize(readFileSync(file)) as Record<string, unknown>;
      stored[field] = new Uint8Array([0]);
      writeFileSync(file, serialize(stored));
      const next = await freshModule();
      next.captureStartupWorkspaceView();
      const waiting = next.waitForSavedStartupWorkspace();
      expect(
        field === "bootstrap"
          ? next.takeStartupBootstrap()
          : next.takeStartupSnapshot(),
      ).toBeNull();
      await expect(waiting).resolves.toBeUndefined();
      expect(next.waitForSavedStartupWorkspace()).toBeNull();
    },
  );

  it("accepts a compatible clean view from a different main build", async () => {
    (await freshModule()).writeStartupWorkspaceView(view("before update"));
    const file = path.join(state.directory, "job-finder-startup-view.bin");
    const stored = deserialize(readFileSync(file)) as {
      build?: { stamp: string; contents: string };
    };
    stored.build = { stamp: "older build", contents: "older bundle" };
    writeFileSync(file, serialize(stored));
    const next = await freshModule();
    next.captureStartupWorkspaceView();
    expect(next.takeStartupSnapshot()).toMatchObject({
      label: "before update",
    });
  });

  it("rejects a view with an incompatible format", async () => {
    (await freshModule()).writeStartupWorkspaceView(view("old format"));
    const file = path.join(state.directory, "job-finder-startup-view.bin");
    const stored = deserialize(readFileSync(file)) as { format: number };
    stored.format = -1;
    writeFileSync(file, serialize(stored));
    const next = await freshModule();
    next.captureStartupWorkspaceView();
    expect(next.takeStartupSnapshot()).toBeNull();
    expect(next.waitForSavedStartupWorkspace()).toBeNull();
  });

  it("removes the view when the close was not clean", async () => {
    (await freshModule()).writeStartupWorkspaceView(view("saved"));
    state.database = null;

    const next = await freshModule();
    next.captureStartupWorkspaceView();

    expect(next.takeStartupSnapshot()).toBeNull();
    expect(
      existsSync(path.join(state.directory, "job-finder-startup-view.bin")),
    ).toBe(false);
  });

  it("saves nothing when shutdown had nothing safe to describe", async () => {
    (await freshModule()).writeStartupWorkspaceView(view("saved"));
    (await freshModule()).writeStartupWorkspaceView(null);

    expect(
      existsSync(path.join(state.directory, "job-finder-startup-view.bin")),
    ).toBe(false);
  });
});
