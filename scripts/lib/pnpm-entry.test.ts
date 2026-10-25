import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  corepackEntrypointCandidates,
  parsePinnedPnpmSpec,
  resolveShellFreePnpmInvocation,
  resolveVerifiedPnpmLauncher,
  writePnpmPathShims,
} from "./pnpm-entry.mjs";

// Some cases build a Unix PATH from real temp directories or run shell scripts
// directly. A Windows drive letter breaks the ":" PATH split and Windows
// cannot run a shebang file, so those cases skip there.
const POSIX_ONLY = "needs a POSIX PATH and shebang execution";
const onWindows = process.platform === "win32";

// Disposable fixtures live under one scratch root in the OS temp dir.
const approvedTempRoot = path.join(os.tmpdir(), "opencode");
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function makeFixture(name: string): string {
  mkdirSync(approvedTempRoot, { recursive: true });
  return mkdtempSync(path.join(approvedTempRoot, `${name}-`));
}

function writeFileEnsuringDir(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

const fakeNode = "/fake/node";

describe("resolveShellFreePnpmInvocation", () => {
  test("prefers npm_execpath over every other candidate and supports paths with spaces", () => {
    const root = makeFixture("npm-execpath");
    const entry = path.join(
      root,
      "pnpm store v3",
      "pnpm-10.8.0",
      "dist",
      "pnpm.cjs",
    );
    writeFileEnsuringDir(entry, "// pnpm stub\n");
    const pathDir = path.join(root, "bin dir");
    writeFileEnsuringDir(path.join(pathDir, "pnpm"), "#!/usr/bin/env node\n");

    const invocation = resolveShellFreePnpmInvocation({
      environment: { npm_execpath: entry, PATH: pathDir },
      platform: "darwin",
      nodeExecutable: fakeNode,
      repositoryRoot: root,
    });

    expect(invocation).not.toBeNull();
    expect(invocation?.source).toBe("npm_execpath");
    expect(invocation?.command).toBe(fakeNode);
    expect(invocation?.entryPoint).toBe(entry);
    expect(invocation?.argsPrefix).toEqual([entry]);
  });

  test("resolves quoted relative npm_execpath values against the repository root", () => {
    const root = makeFixture("npm-execpath-relative");
    const entry = path.join(root, "tooling", "pnpm.cjs");
    writeFileEnsuringDir(entry, "// pnpm stub\n");

    const invocation = resolveShellFreePnpmInvocation({
      environment: { npm_execpath: `"./tooling/pnpm.cjs"` },
      platform: "linux",
      nodeExecutable: fakeNode,
      repositoryRoot: root,
    });

    expect(invocation?.source).toBe("npm_execpath");
    expect(invocation?.entryPoint).toBe(entry);
  });

  test("ignores npm_execpath values that do not look like pnpm and falls through to a PATH node script", () => {
    const root = makeFixture("npm-execpath-reject");
    writeFileEnsuringDir(path.join(root, "other.cjs"), "// not pnpm\n");
    const pathDir = path.join(root, "bin dir");
    writeFileEnsuringDir(path.join(pathDir, "pnpm"), "#!/usr/bin/env node\n");

    const invocation = resolveShellFreePnpmInvocation({
      environment: {
        npm_execpath: path.join(root, "other.cjs"),
        PATH: pathDir,
      },
      platform: "darwin",
      nodeExecutable: fakeNode,
      repositoryRoot: root,
    });

    expect(invocation?.source).toBe("path-node-script");
  });

  test("resolves vendored pnpm through the supplied root resolver", () => {
    const root = makeFixture("vendored");
    const vendored = path.join(root, "node_modules", "pnpm", "bin", "pnpm.cjs");
    writeFileEnsuringDir(vendored, "// vendored pnpm\n");

    const invocation = resolveShellFreePnpmInvocation({
      environment: {},
      platform: "linux",
      nodeExecutable: fakeNode,
      repositoryRoot: root,
      resolveFromRoot: (specifier: string) => {
        if (specifier !== "pnpm/bin/pnpm.cjs") {
          throw new Error(`unexpected specifier ${specifier}`);
        }
        return vendored;
      },
    });

    expect(invocation?.source).toBe("vendored-pnpm");
    expect(invocation?.entryPoint).toBe(vendored);
  });

  test("requires a shebang for PATH scripts and skips non-script entries", ({
    skip,
  }) => {
    skip(onWindows, POSIX_ONLY);
    const root = makeFixture("path-shebang");
    const plain = makeFixture("path-plain");
    writeFileSync(path.join(plain, "pnpm"), "console.log('not a script');\n");

    expect(
      resolveShellFreePnpmInvocation({
        environment: { PATH: plain },
        platform: "darwin",
        nodeExecutable: fakeNode,
        repositoryRoot: root,
      }),
    ).toBeNull();

    const scripted = makeFixture("path-scripted");
    writeFileSync(path.join(scripted, "pnpm"), "#!/usr/bin/env node\n");
    expect(
      resolveShellFreePnpmInvocation({
        environment: { PATH: `${scripted}::${plain}` },
        platform: "linux",
        nodeExecutable: fakeNode,
        repositoryRoot: root,
      })?.source,
    ).toBe("path-node-script");
  });

  test("never scans PATH on Windows because .cmd shims cannot be spawned shell-free", () => {
    const root = makeFixture("windows-path");
    const pathDir = path.join(root, "bin");
    writeFileEnsuringDir(path.join(pathDir, "pnpm"), "#!/usr/bin/env node\n");

    expect(
      resolveShellFreePnpmInvocation({
        environment: { PATH: pathDir },
        platform: "win32",
        nodeExecutable: "C:\\node.exe",
        repositoryRoot: root,
      }),
    ).toBeNull();
  });

  test("treats Corepack as an optional candidate that wins only when listed and present", () => {
    const root = makeFixture("corepack-optional");
    const corepackEntry = path.join(
      root,
      "lib",
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );
    writeFileEnsuringDir(corepackEntry, "// corepack stub\n");
    const pathDir = path.join(root, "bin");
    writeFileEnsuringDir(path.join(pathDir, "pnpm"), "#!/usr/bin/env node\n");
    const base = {
      environment: { PATH: pathDir },
      platform: "darwin" as const,
      nodeExecutable: fakeNode,
      repositoryRoot: root,
    };

    expect(
      resolveShellFreePnpmInvocation({
        ...base,
        corepackCandidates: [corepackEntry],
      })?.source,
    ).toBe("corepack");

    expect(
      resolveShellFreePnpmInvocation({ ...base, corepackCandidates: [] })
        ?.source,
    ).toBe("path-node-script");

    // Listed but absent candidates are ignored instead of trusted.
    expect(
      resolveShellFreePnpmInvocation({
        ...base,
        environment: { PATH: "" },
        corepackCandidates: [path.join(root, "missing", "corepack.js")],
      }),
    ).toBeNull();
  });
});

describe("corepackEntrypointCandidates", () => {
  test("covers the Windows layout plus every Unix prefix layout above nodeDir", () => {
    const root = makeFixture("corepack-candidates");
    const nodeDir = path.join(root, "Cellar", "node", "26.4.0", "bin");
    const candidates = corepackEntrypointCandidates(nodeDir);

    expect(candidates[0]).toBe(
      path.join(nodeDir, "node_modules", "corepack", "dist", "corepack.js"),
    );
    expect(candidates).toContain(
      path.join(root, "lib", "node_modules", "corepack", "dist", "corepack.js"),
    );
    expect(candidates).toContain(
      path.join(
        root,
        "Cellar",
        "lib",
        "node_modules",
        "corepack",
        "dist",
        "corepack.js",
      ),
    );
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("finds a Unix Homebrew-style corepack layout beside Node 26 without one", () => {
    const root = makeFixture("corepack-unix-layout");
    const nodeDir = path.join(root, "Cellar", "node", "26.4.0", "bin");
    const corepackEntry = path.join(
      root,
      "lib",
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );
    writeFileEnsuringDir(corepackEntry, "// corepack stub\n");

    // Node >= 25 ships no corepack: nothing exists under bin/. The candidate
    // walk upward must still surface the prefix-level install.
    const candidates = corepackEntrypointCandidates(nodeDir).filter(
      (candidate) => candidate.startsWith(root),
    );

    const invocation = resolveShellFreePnpmInvocation({
      environment: {},
      platform: "darwin",
      nodeExecutable: path.join(nodeDir, "node"),
      repositoryRoot: root,
      corepackCandidates: candidates,
    });
    expect(invocation?.source).toBe("corepack");
    expect(invocation?.entryPoint).toBe(corepackEntry);
  });
});

describe("parsePinnedPnpmSpec", () => {
  test("parses pinned versions and strips integrity suffixes", () => {
    expect(parsePinnedPnpmSpec("pnpm@10.8.0")).toEqual({
      name: "pnpm",
      version: "10.8.0",
      spec: "pnpm@10.8.0",
    });
    expect(parsePinnedPnpmSpec("pnpm@10.8.0+sha512.abc123")?.version).toBe(
      "10.8.0",
    );
    expect(parsePinnedPnpmSpec("  pnpm@10.8.0 \n")?.version).toBe("10.8.0");
    expect(parsePinnedPnpmSpec("pnpm@10.8.0-beta.1")?.version).toBe(
      "10.8.0-beta.1",
    );
  });

  test("rejects values that do not pin pnpm", () => {
    expect(parsePinnedPnpmSpec("yarn@1.22.0")).toBeNull();
    expect(parsePinnedPnpmSpec("pnpm@latest")).toBeNull();
    expect(parsePinnedPnpmSpec("pnpm")).toBeNull();
    expect(parsePinnedPnpmSpec("")).toBeNull();
    expect(parsePinnedPnpmSpec(undefined)).toBeNull();
  });
});

describe("resolveVerifiedPnpmLauncher", () => {
  test("authorizes a direct entry whose reported version matches the pin", () => {
    const root = makeFixture("launcher-direct");
    const entry = path.join(root, "store", "pnpm.cjs");
    writeFileEnsuringDir(entry, "// pnpm stub\n");
    const probed: string[] = [];

    const launcher = resolveVerifiedPnpmLauncher({
      packageManagerString: "pnpm@10.8.0",
      environment: { npm_execpath: entry },
      platform: "linux",
      nodeExecutable: fakeNode,
      repositoryRoot: root,
      readVersion: ({ invocation }: { invocation: { entryPoint: string } }) => {
        probed.push(invocation.entryPoint);
        return "10.8.0\n";
      },
    });

    expect(launcher.kind).toBe("direct");
    expect(launcher.pinnedVersion).toBe("10.8.0");
    expect(probed).toEqual([entry]);
  });

  test("fails closed naming both versions when the resolved pnpm mismatches the pin", () => {
    const root = makeFixture("launcher-mismatch");
    const entry = path.join(root, "old", "pnpm.cjs");
    writeFileEnsuringDir(entry, "// old pnpm\n");

    expect(() =>
      resolveVerifiedPnpmLauncher({
        packageManagerString: "pnpm@10.8.0",
        environment: { npm_execpath: entry },
        platform: "darwin",
        nodeExecutable: fakeNode,
        repositoryRoot: root,
        readVersion: () => "9.15.9",
      }),
    ).toThrowError(/reports version 9\.15\.9.*pins pnpm@10\.8\.0/s);
  });

  test("tolerates a leading v in reported versions", () => {
    const root = makeFixture("launcher-vprefix");
    const entry = path.join(root, "pnpm.mjs");
    writeFileEnsuringDir(entry, "// pnpm stub\n");

    expect(
      resolveVerifiedPnpmLauncher({
        packageManagerString: "pnpm@10.8.0",
        environment: { npm_execpath: entry },
        platform: "linux",
        nodeExecutable: fakeNode,
        repositoryRoot: root,
        readVersion: () => "v10.8.0",
      }).kind,
    ).toBe("direct");
  });

  test("a Corepack entry skips the probe and carries the full pinned spec verbatim", () => {
    const root = makeFixture("launcher-corepack");
    const corepackEntry = path.join(
      root,
      "lib",
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );
    writeFileEnsuringDir(corepackEntry, "// corepack stub\n");
    let probeCalls = 0;

    const launcher = resolveVerifiedPnpmLauncher({
      packageManagerString: "pnpm@10.8.0+sha512.deadbeef",
      environment: {},
      platform: "darwin",
      nodeExecutable: fakeNode,
      repositoryRoot: root,
      corepackCandidates: [corepackEntry],
      readVersion: () => {
        probeCalls += 1;
        return "10.8.0";
      },
    });

    expect(launcher.kind).toBe("corepack");
    expect(probeCalls).toBe(0);
    expect(launcher.corepackEntrypoint).toBe(corepackEntry);
    expect(launcher.packageManagerSpec).toBe("pnpm@10.8.0+sha512.deadbeef");
  });

  test("fails closed when no candidate exists anywhere (Corepack-less Node)", () => {
    const root = makeFixture("launcher-none");

    expect(() =>
      resolveVerifiedPnpmLauncher({
        packageManagerString: "pnpm@10.8.0",
        environment: {},
        platform: "linux",
        nodeExecutable: path.join(root, "bin", "node"),
        repositoryRoot: root,
        corepackCandidates: corepackEntrypointCandidates(
          path.join(root, "bin"),
        ).filter((candidate) => candidate.startsWith(root)),
      }),
    ).toThrowError(/no shell-free pnpm JavaScript entry point/);
  });

  test("fails closed before resolution when packageManager does not pin pnpm", () => {
    expect(() =>
      resolveVerifiedPnpmLauncher({
        packageManagerString: "npm@10.0.0",
        environment: {},
        platform: "linux",
        nodeExecutable: fakeNode,
        repositoryRoot: os.tmpdir(),
      }),
    ).toThrowError(/must pin pnpm through "packageManager"/);
  });
});

describe("writePnpmPathShims", () => {
  test("writes a POSIX trampoline that safely forwards arguments through spaced and quoted paths", ({
    skip,
  }) => {
    skip(onWindows, POSIX_ONLY);
    const root = makeFixture("shim-posix");
    const entry = path.join(root, "odd pnpm's dir", "pnpm-stub.cjs");
    writeFileEnsuringDir(
      entry,
      [
        'const fs = require("node:fs");',
        'if (process.argv[2] === "--version") {',
        '  process.stdout.write("10.8.0\\n");',
        "  process.exit(0);",
        "}",
        "fs.writeFileSync(",
        '  process.env.SHIM_RECORD ?? "",',
        "  JSON.stringify({ argv: process.argv.slice(2) }),",
        ");",
      ].join("\n"),
    );
    const recordPath = path.join(root, "record.json");

    const { platform, shimPath } = writePnpmPathShims({
      shimDir: root,
      nodeExecutable: process.execPath,
      entryPoint: entry,
      platform: "linux",
    });

    expect(platform).toBe("posix");
    expect(path.basename(shimPath)).toBe("pnpm");
    expect(readFileSync(shimPath, "utf8")).toContain('"$@"');

    execFileSync(shimPath, ["run", "lint"], {
      env: { ...process.env, SHIM_RECORD: recordPath },
    });

    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual({
      argv: ["run", "lint"],
    });
  });

  test("writes a quoted Windows cmd shim that escapes percent signs", () => {
    const root = makeFixture("shim-win32");
    const { platform, shimPath } = writePnpmPathShims({
      shimDir: root,
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      entryPoint: "C:\\my 100% store\\pnpm.cjs",
      platform: "win32",
    });

    expect(platform).toBe("win32");
    expect(path.basename(shimPath)).toBe("pnpm.cmd");
    const contents = readFileSync(shimPath, "utf8");
    expect(contents.startsWith("@echo off\r\n")).toBe(true);
    expect(contents).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(contents).toContain('"C:\\my 100%% store\\pnpm.cjs" %*');
  });
});

describe("run-turbo argument contract", () => {
  test("forwards existing turbo arguments through the verified pnpm entry without Corepack", ({
    skip,
  }) => {
    skip(onWindows, POSIX_ONLY);
    const root = makeFixture("turbo-e2e");
    const recordPath = path.join(root, "record.json");
    const fakeEntry = path.join(root, "fake pnpm store", "pnpm.cjs");
    const pinnedVersion = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ).packageManager.split("@")[1] as string;
    writeFileEnsuringDir(
      fakeEntry,
      [
        'const fs = require("node:fs");',
        'if (process.argv[2] === "--version") {',
        '  process.stdout.write(process.env.FAKE_PNPM_VERSION + "\\n");',
        "  process.exit(0);",
        "}",
        "fs.writeFileSync(",
        '  process.env.FAKE_PNPM_RECORD ?? "",',
        "  JSON.stringify({ argv: process.argv.slice(2) }),",
        ");",
        'process.stdout.write("fake turbo reached\\n");',
      ].join("\n"),
    );
    const runTurboScript = path.join(
      repositoryRoot,
      "scripts",
      "run-turbo.mjs",
    );

    execFileSync(
      process.execPath,
      [runTurboScript, "lint", "typecheck", "--dry"],
      {
        env: {
          ...process.env,
          npm_execpath: fakeEntry,
          FAKE_PNPM_RECORD: recordPath,
          FAKE_PNPM_VERSION: pinnedVersion,
        },
        encoding: "utf8",
      },
    );

    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual({
      argv: ["exec", "turbo", "lint", "typecheck", "--dry"],
    });
  });
});
