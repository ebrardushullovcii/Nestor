import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
