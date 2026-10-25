import type { App } from "electron";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { migrateLegacyDesktopUserData } from "./legacy-user-data-migration";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createAppData() {
  const appData = mkdtempSync(path.join(os.tmpdir(), "nestor-app-data-"));
  temporaryDirectories.push(appData);
  return appData;
}

function fakeApp(
  appData: string,
  name: string,
  userData = path.join(appData, name),
) {
  return {
    getName: () => name,
    getPath: (key: string) => (key === "appData" ? appData : userData),
  } as unknown as Pick<App, "getName" | "getPath">;
}

function seedLegacyWorkspace(directory: string) {
  mkdirSync(path.join(directory, "interview-helper-screenshots"), {
    recursive: true,
  });
  writeFileSync(path.join(directory, "job-finder-workspace.sqlite"), "jobs");
  writeFileSync(path.join(directory, "interview-helper-workspace.json"), "{}");
}

describe("migrateLegacyDesktopUserData", () => {
  test("moves the development workspace and drops the empty scope folder", () => {
    const appData = createAppData();
    seedLegacyWorkspace(path.join(appData, "@unemployed", "desktop"));

    const result = migrateLegacyDesktopUserData(
      fakeApp(appData, "@nestor/desktop"),
      {
        configuredDirectory: null,
      },
    );

    const target = path.join(appData, "@nestor", "desktop");
    expect(result.movedDirectory).toEqual({
      from: path.join(appData, "@unemployed", "desktop"),
      to: target,
    });
    expect(
      readFileSync(path.join(target, "job-finder-workspace.sqlite"), "utf8"),
    ).toBe("jobs");
    expect(existsSync(path.join(target, "live-assistant-workspace.json"))).toBe(
      true,
    );
    expect(existsSync(path.join(target, "live-assistant-screenshots"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(target, "interview-helper-workspace.json")),
    ).toBe(false);
    expect(existsSync(path.join(appData, "@unemployed"))).toBe(false);
  });

  test("moves the packaged workspace into an empty directory Electron already made", () => {
    const appData = createAppData();
    seedLegacyWorkspace(path.join(appData, "UnEmployed"));
    mkdirSync(path.join(appData, "Nestor"));

    const result = migrateLegacyDesktopUserData(fakeApp(appData, "Nestor"), {
      configuredDirectory: null,
    });

    expect(result.movedDirectory?.to).toBe(path.join(appData, "Nestor"));
    expect(
      existsSync(path.join(appData, "Nestor", "job-finder-workspace.sqlite")),
    ).toBe(true);
    expect(existsSync(path.join(appData, "UnEmployed"))).toBe(false);
  });

  test("never merges into a directory that already holds data", () => {
    const appData = createAppData();
    seedLegacyWorkspace(path.join(appData, "UnEmployed"));
    mkdirSync(path.join(appData, "Nestor"));
    writeFileSync(
      path.join(appData, "Nestor", "job-finder-workspace.sqlite"),
      "new",
    );

    const result = migrateLegacyDesktopUserData(fakeApp(appData, "Nestor"), {
      configuredDirectory: null,
    });

    expect(result).toMatchObject({
      movedDirectory: null,
      skippedReason: "target-has-data",
    });
    expect(
      readFileSync(
        path.join(appData, "Nestor", "job-finder-workspace.sqlite"),
        "utf8",
      ),
    ).toBe("new");
    expect(
      existsSync(
        path.join(appData, "UnEmployed", "job-finder-workspace.sqlite"),
      ),
    ).toBe(true);
  });

  test("an isolated session directory never adopts the real workspace", () => {
    const appData = createAppData();
    seedLegacyWorkspace(path.join(appData, "@unemployed", "desktop"));
    const isolated = path.join(appData, "isolated-session");
    mkdirSync(isolated);

    const result = migrateLegacyDesktopUserData(
      fakeApp(appData, "@nestor/desktop", isolated),
      { configuredDirectory: isolated },
    );

    expect(result.movedDirectory).toBeNull();
    expect(existsSync(path.join(appData, "@unemployed", "desktop"))).toBe(true);
    expect(existsSync(path.join(isolated, "job-finder-workspace.sqlite"))).toBe(
      false,
    );
  });

  test("a --user-data-dir switch never adopts the real workspace", () => {
    const appData = createAppData();
    seedLegacyWorkspace(path.join(appData, "@unemployed", "desktop"));
    const switched = path.join(appData, "demo-workspace");
    mkdirSync(switched);

    const result = migrateLegacyDesktopUserData(
      fakeApp(appData, "@nestor/desktop", switched),
      { configuredDirectory: null },
    );

    expect(result.movedDirectory).toBeNull();
    expect(existsSync(path.join(appData, "@unemployed", "desktop"))).toBe(true);
    expect(existsSync(path.join(switched, "job-finder-workspace.sqlite"))).toBe(
      false,
    );
  });

  test("renames old module files inside an isolated session directory", () => {
    const appData = createAppData();
    const isolated = path.join(appData, "isolated-session");
    seedLegacyWorkspace(isolated);

    const result = migrateLegacyDesktopUserData(
      fakeApp(appData, "@nestor/desktop", isolated),
      { configuredDirectory: isolated },
    );

    expect(result.renamedEntries).toEqual([
      "live-assistant-workspace.json",
      "live-assistant-screenshots",
    ]);
  });

  test("moves the Nordri workspace before an older UnEmployed one", () => {
    const appData = createAppData();
    const nordri = path.join(appData, "@nordri", "desktop");
    mkdirSync(path.join(nordri, "Partitions", "unemployed-browser"), {
      recursive: true,
    });
    writeFileSync(path.join(nordri, "job-finder-workspace.sqlite"), "nordri");
    seedLegacyWorkspace(path.join(appData, "@unemployed", "desktop"));

    const result = migrateLegacyDesktopUserData(
      fakeApp(appData, "@nestor/desktop"),
      {
        configuredDirectory: null,
      },
    );

    const target = path.join(appData, "@nestor", "desktop");
    expect(result.movedDirectory).toEqual({ from: nordri, to: target });
    expect(
      readFileSync(path.join(target, "job-finder-workspace.sqlite"), "utf8"),
    ).toBe("nordri");
    expect(result.renamedEntries).toEqual([
      path.join("Partitions", "nestor-browser"),
    ]);
    expect(existsSync(path.join(target, "Partitions", "nestor-browser"))).toBe(
      true,
    );
    expect(existsSync(path.join(appData, "@nordri"))).toBe(false);
    expect(existsSync(path.join(appData, "@unemployed", "desktop"))).toBe(true);
  });

  test("keeps the newer browser partition when both old ones exist", () => {
    const appData = createAppData();
    const target = path.join(appData, "Nestor");
    mkdirSync(path.join(target, "Partitions", "nordri-browser"), {
      recursive: true,
    });
    mkdirSync(path.join(target, "Partitions", "unemployed-browser"));

    migrateLegacyDesktopUserData(fakeApp(appData, "Nestor"), {
      configuredDirectory: null,
    });

    expect(existsSync(path.join(target, "Partitions", "nestor-browser"))).toBe(
      true,
    );
    expect(existsSync(path.join(target, "Partitions", "nordri-browser"))).toBe(
      false,
    );
    expect(
      existsSync(path.join(target, "Partitions", "unemployed-browser")),
    ).toBe(true);
  });

  test("does nothing on a fresh install", () => {
    const appData = createAppData();

    expect(
      migrateLegacyDesktopUserData(fakeApp(appData, "Nestor"), {
        configuredDirectory: null,
      }),
    ).toEqual({
      movedDirectory: null,
      renamedEntries: [],
      skippedReason: null,
    });
    expect(existsSync(path.join(appData, "Nestor"))).toBe(false);
  });
});
