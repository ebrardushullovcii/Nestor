import type { App } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  configureDesktopUserDataDirectory,
  getConfiguredDesktopUserDataDirectory,
  getDesktopStartupDiagnosticsPath,
  resolveDesktopUserDataDirectory,
} from "./user-data-directory";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("configureDesktopUserDataDirectory", () => {
  test.each([undefined, "", "   "])(
    "keeps Electron defaults for %j",
    (configuredDirectory) => {
      const setPath = vi.fn();

      expect(
        configureDesktopUserDataDirectory(
          { setPath } as unknown as Pick<App, "setPath">,
          configuredDirectory,
        ),
      ).toBeNull();
      expect(setPath).not.toHaveBeenCalled();
    },
  );

  test("creates and applies one absolute directory before Electron session startup", () => {
    const parentDirectory = mkdtempSync(
      path.join(os.tmpdir(), "nestor-user-data-"),
    );
    temporaryDirectories.push(parentDirectory);
    const requestedDirectory = path.join(parentDirectory, "isolated-session");
    const setPath = vi.fn();

    const configuredDirectory = configureDesktopUserDataDirectory(
      { setPath } as unknown as Pick<App, "setPath">,
      `  ${requestedDirectory}  `,
    );

    expect(configuredDirectory).toBe(path.resolve(requestedDirectory));
    expect(setPath).toHaveBeenCalledOnce();
    expect(setPath).toHaveBeenCalledWith("userData", configuredDirectory);
  });

  test("normalizes padded relative overrides for every desktop consumer", () => {
    const parentDirectory = mkdtempSync(
      path.join(os.tmpdir(), "nestor-user-data-relative-"),
    );
    temporaryDirectories.push(parentDirectory);
    const requestedDirectory = path.join(parentDirectory, "isolated-session");
    const relativeOverride = path.relative(process.cwd(), requestedDirectory);
    const paddedOverride = `  ${relativeOverride}  `;

    expect(getConfiguredDesktopUserDataDirectory(paddedOverride)).toBe(
      path.resolve(requestedDirectory),
    );
    expect(
      resolveDesktopUserDataDirectory(
        { getPath: () => "C:\\default-user-data" },
        paddedOverride,
      ),
    ).toBe(path.resolve(requestedDirectory));
    expect(getDesktopStartupDiagnosticsPath(paddedOverride)).toBe(
      path.join(path.resolve(requestedDirectory), "startup-diagnostics.log"),
    );
  });

  test("keeps Electron's default user-data path when no override is configured", () => {
    const defaultDirectory = path.join(
      os.tmpdir(),
      "nestor-default-user-data",
    );

    expect(
      resolveDesktopUserDataDirectory(
        { getPath: () => defaultDirectory },
        "   ",
      ),
    ).toBe(defaultDirectory);
    expect(getDesktopStartupDiagnosticsPath("   ")).toBeNull();
  });
});
