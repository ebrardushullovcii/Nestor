import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  deriveProfileSetupState,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";

import {
  BLIND_PERSONA_SEED_HELP,
  BLIND_PERSONA_TESTER_HELP,
  BLIND_PERSONA_VERIFY_ALL_HELP,
  createUniquePersonaRoot,
  compareCodeUnitOrder,
  currentSourcePathSetDigest,
  dependencyIdentity,
  hardenSeedEnvironment,
  hardenTesterEnvironment,
  inventoryTree,
  isBrowserManagedTransientSidecar,
  isPathInside,
  launchBlindPersonaTester,
  launchElectronWithMainEvaluation,
  parseBlindPersonaSeedCli,
  parseBlindPersonaTesterCli,
  parseBlindPersonaVerifyAllCli,
  prepareBlindPersonaWorkspaces,
  resolveConfinedPath,
  scanCrossPersonaPaths,
  scanSeedAuthority,
  sha256,
  stableSeedSerialization,
  summarizeTesterStartupGeometryApplied,
  testerLaunchIntentName,
  testerLaunchRecordName,
  verifyAcceptedBuild,
  verifyAllPreparedPersonaWorkspaces,
  verifyPreparedPersonaWorkspace,
  type ElectronSeedProcess,
  type LaunchSeedElectron,
} from "./prepare-blind-persona-workspaces";
import { createEmptyJobFinderRepositoryState } from "../src/main/adapters/job-finder-initial-state";
import {
  migrateLegacyResumeSource,
  missingResumeSourceWarning,
} from "../src/main/services/job-finder/migrate-resume-source";
import {
  dependencyRootsFingerprint,
  digestSeed,
  sourceFingerprint,
  stableJson,
} from "./release-acceptance-harness.mjs";

interface ParityProbe {
  [key: string]: unknown;
}

// Custody writer/verifier serializer parity. The seeder writes custody and
// verifies seals through stableSeedSerialization while the acceptance harness
// (digestSeed) and the tester CLI bootstrap check recompute the same digests
// through stableJson. Both MUST stay byte-identical for keys whose relative
// order differs between code-unit sort and locale collation — mixed-case and
// non-ASCII keys are exactly where a localeCompare-based duplicate diverged.
describe("blind persona canonical serializer custody parity", () => {
  const divergenceProbes: Array<[string, ParityProbe]> = [
    ["non-ASCII keys", { z: 1, ä: 2, 中: 3 }],
    ["mixed-case ASCII keys", { a: 1, B: 2 }],
    [
      "custody-shaped mixed payload",
      {
        build: { finalSealSha256: "a".repeat(64), runDir: "/run/P01-x" },
        personas: [{ personaId: "P01", userDataRoot: "/roots/P01" }],
        waveComplete: true,
        zKey: { B: 1, ä: 2 },
      },
    ],
  ];

  it.each(divergenceProbes)(
    "%s serialize identically to the harness",
    (_label, probe) => {
      expect(stableSeedSerialization(probe)).toBe(stableJson(probe));
      expect(sha256(stableSeedSerialization(probe))).toBe(digestSeed(probe));
    },
  );

  it("pins canonical key order to code-unit sort, not locale collation", () => {
    expect(stableSeedSerialization({ z: 1, ä: 2 })).toBe('{"z":1,"ä":2}');
    expect(stableSeedSerialization({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it("keeps custody index verification exact under the tester CLI digestSeed check", () => {
    // Mirrors launch-blind-persona-tester-cli.mjs: the custody subject minus
    // its digest must satisfy digestSeed(subject) === written digest.
    const subject = {
      binding: { acceptanceVersion: 1 },
      entries: [{ personaId: "P02" }],
      waveComplete: true,
      äKey: { BKey: true, aKey: false },
    };
    expect(digestSeed(subject)).toBe(sha256(stableSeedSerialization(subject)));
  });
});

describe("persona launcher main-process evaluation ownership", () => {
  const input = {
    args: ["--remote-debugging-port=0"],
    cwd: "/accepted-app",
    env: { PATH: "/bin", OMITTED: undefined },
    executablePath: "/accepted-app/Electron",
  };

  function fakePlaywrightApplication(
    identity: string,
    onClose: () => void = () => undefined,
  ) {
    return {
      close: async () => onClose(),
      evaluate: async <R>(callback: (electron: unknown) => R): Promise<R> =>
        callback({ identity }),
      firstWindow: async () => ({
        evaluate: async <R>(callback: (window: unknown) => R): Promise<R> =>
          callback({ identity }),
        waitForFunction: async () => undefined,
        waitForLoadState: async () => undefined,
      }),
      process: () => ({
        exitCode: null,
        pid: [...identity].reduce(
          (sum, character) => sum + character.charCodeAt(0),
          0,
        ),
        signalCode: null,
      }),
    };
  }

  it("adapts an isolated real-launch boundary to the required main evaluation channel", async () => {
    let receivedEnvironment: Record<string, string> | undefined;
    const application = await launchElectronWithMainEvaluation(
      input,
      async (options) => {
        receivedEnvironment = options.env;
        return fakePlaywrightApplication("single");
      },
    );

    await expect(
      application.evaluateInMain?.((electron) =>
        String((electron as { identity: string }).identity),
      ),
    ).resolves.toBe("single");
    expect(receivedEnvironment).toEqual({ PATH: "/bin" });
  });

  it("keeps concurrent launch evaluation channels attached to their owning applications", async () => {
    const closeCounts = { P01: 0, P02: 0 };
    const launches = ["P01", "P02"].map((identity) =>
      launchElectronWithMainEvaluation(input, async () =>
        fakePlaywrightApplication(identity, () => {
          closeCounts[identity as keyof typeof closeCounts] += 1;
        }),
      ),
    );
    const [first, second] = await Promise.all(launches);

    const [firstIdentity, secondIdentity, firstWindow, secondWindow] =
      await Promise.all([
        first.evaluateInMain?.((electron) =>
          String((electron as { identity: string }).identity),
        ),
        second.evaluateInMain?.((electron) =>
          String((electron as { identity: string }).identity),
        ),
        first.firstWindow(),
        second.firstWindow(),
      ]);

    expect([firstIdentity, secondIdentity]).toEqual(["P01", "P02"]);
    await expect(
      firstWindow.evaluate((window) =>
        String((window as { identity: string }).identity),
      ),
    ).resolves.toBe("P01");
    await expect(
      secondWindow.evaluate((window) =>
        String((window as { identity: string }).identity),
      ),
    ).resolves.toBe("P02");
    expect(first.process()?.pid).not.toBe(second.process()?.pid);

    await first.close();
    expect(closeCounts).toEqual({ P01: 1, P02: 0 });
    await second.close();
    expect(closeCounts).toEqual({ P01: 1, P02: 1 });
  });
});

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    spawn("git", args, { cwd })
      .on("error", reject)
      .on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`git ${args.join(" ")} exited ${code}`)),
      );
  });
}

// Path-set digest custody determinism. The captured path set is serialized as
// an ordered array, so its sort must be plain code-unit order (matching
// stableJson key ordering); a localeCompare regression would make the digest
// depend on the verifying machine's ICU locale.
describe("blind persona source path-set digest ordering", () => {
  it("waits for the startup workspace read before the one seed reset", async () => {
    const source = await readFile(
      path.join(
        repositoryRoot,
        "apps/desktop/scripts/prepare-blind-persona-workspaces.ts",
      ),
      "utf8",
    );
    const readinessIndex = source.indexOf("await workspaceApi();");
    const resetIndex = source.indexOf("return resetApi(repositoryState);");

    expect(readinessIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(readinessIndex);
  });

  it("digests code-unit-sorted paths, never ambient-locale collation", async () => {
    // "R" sorts before "a" and "Ä" after "z" ONLY in code-unit order; every
    // common collation reorders at least one of these pairs.
    const paths = ["README", "alpha.txt", "zeta.txt", "Änderung.txt"];
    const fixtureRoot = await uniqueTestRoot("blind-source-path-set-digest");
    await runGit(["init"], fixtureRoot);
    for (const name of paths) {
      await writeFile(path.join(fixtureRoot, name), "custody\n");
    }
    const digest = await currentSourcePathSetDigest(fixtureRoot);
    expect(digest).toBe(sha256(stableSeedSerialization(paths)));
    // Fixture guard pinned to explicit CLDR "en" collation (deterministic
    // across ICU builds): if these orders ever stopped diverging from
    // code-unit order, this regression would be vacuous.
    const localeOrder = [...paths].sort(new Intl.Collator("en").compare);
    expect(localeOrder).not.toEqual(paths);
    expect(sha256(stableSeedSerialization(localeOrder))).not.toBe(digest);
  });

  // Cross-implementation custody parity: the acceptance harness seals
  // sourceFingerprint().pathSetDigest while this seeder recomputes
  // currentSourcePathSetDigest() over the live worktree. Both must order the
  // same full paths identically (code-unit), or a mixed-case/non-ASCII worktree
  // would fail verifyAcceptedBuild purely on inventory ordering.
  it("recomputes the acceptance producer's sealed source path-set digest byte-identically", async () => {
    const paths = ["README", "alpha/nested.txt", "zeta.txt", "Änderung.txt"];
    const excludedPaths = [
      "apps/desktop/test-artifacts/generated.json",
      "packages/browser-agent/tsconfig.tsbuildinfo",
      "docs/audits/evidence-manifests/generated.manifest.json",
    ];
    const fixtureRoot = await uniqueTestRoot("blind-source-producer-parity");
    await runGit(["init"], fixtureRoot);
    for (const name of [...paths, ...excludedPaths]) {
      await mkdir(path.dirname(path.join(fixtureRoot, name)), {
        recursive: true,
      });
      await writeFile(path.join(fixtureRoot, name), "custody\n");
    }
    const producer = await sourceFingerprint(fixtureRoot);
    const verifierDigest = await currentSourcePathSetDigest(fixtureRoot);
    expect(producer.pathSetDigest).toBe(verifierDigest);
    const codeUnitOrder = [...paths].sort();
    expect(producer.files.map((entry) => entry.path)).toEqual(codeUnitOrder);
    // Fixture guard: these paths genuinely diverge from ambient collation, so
    // a localeCompare regression in either implementation fails this test.
    const localeOrder = [...paths].sort(new Intl.Collator("en").compare);
    expect(localeOrder).not.toEqual(codeUnitOrder);
    expect(sha256(stableSeedSerialization(localeOrder))).not.toBe(
      verifierDigest,
    );
  });

  it("orders custody inventory entries by deterministic code units", async () => {
    const fixtureRoot = await uniqueTestRoot("blind-custody-inventory-order");
    for (const name of ["zeta.txt", "Änderung.txt", "alpha.txt", "Beta.txt"]) {
      await writeFile(path.join(fixtureRoot, name), `${name}\n`);
    }

    const first = await inventoryTree(fixtureRoot);
    const second = await inventoryTree(fixtureRoot);
    const expectedPaths = ["Beta.txt", "alpha.txt", "zeta.txt", "Änderung.txt"];
    expect(first.files.map((entry) => entry.path)).toEqual(expectedPaths);
    expect(first.digest).toBe(second.digest);
    expect([...expectedPaths].sort(compareCodeUnitOrder)).toEqual(
      expectedPaths,
    );
    expect(
      [...expectedPaths].sort(new Intl.Collator("en").compare),
    ).not.toEqual(expectedPaths);
  });

  it("excludes only exact top-level Chromium DIPS sidecars from payload inventory", async () => {
    const fixtureRoot = await uniqueTestRoot("blind-dips-inventory-boundary");
    for (const relativePath of [
      "DIPS",
      "DIPS-shm",
      "DIPS-wal",
      "nested/DIPS-shm",
      "nested/DIPS-wal",
      "arbitrary-shm",
    ]) {
      const filePath = path.join(fixtureRoot, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${relativePath}\n`);
    }

    const inventory = await inventoryTree(fixtureRoot);
    const paths = inventory.files.map((entry) => entry.path);

    expect(isBrowserManagedTransientSidecar("DIPS-shm")).toBe(true);
    expect(isBrowserManagedTransientSidecar("DIPS-wal")).toBe(true);
    expect(isBrowserManagedTransientSidecar("DIPS")).toBe(false);
    expect(isBrowserManagedTransientSidecar("nested/DIPS-shm")).toBe(false);
    expect(isBrowserManagedTransientSidecar("arbitrary-shm")).toBe(false);
    expect(paths).toEqual([
      "DIPS",
      "arbitrary-shm",
      "nested/DIPS-shm",
      "nested/DIPS-wal",
    ]);
  });
});

// Windows runs this harness slower on every axis: the fake accepted build is
// copied, hashed and sealed on NTFS, each simulated launch spawns a process,
// and removals retry until handles are released. That regularly outgrows
// vitest's 5s default and the suite fails on the clock rather than on
// behaviour. POSIX keeps the default, so a real hang still fails fast there.
if (process.platform === "win32") {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
}

// The harness's approved scratch root, resolved so it is a real path on this
// platform: Windows has no "/private/var/..." and path.join would leave a
// driveless "\private\var\..." that never matched the canonical paths the
// code under test returns.
const approvedTempRoot = path.resolve(
  process.platform === "win32"
    ? path.join(os.tmpdir(), "opencode")
    : "/private/var/folders/nh/pj6dg1rj2kvdgrh75f7b5krr0000gn/T/opencode",
);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function uniqueTestRoot(label: string): Promise<string> {
  const root = path.join(approvedTempRoot, `${label}-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function acceptedLocalSources() {
  const blindManifest = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "apps/desktop/test-fixtures/job-finder/blind-personas/manifest.json",
      ),
      "utf8",
    ),
  ) as {
    jobCorpusPath: string;
    sessions: { resumeInput: { path: string } }[];
  };
  const paths = [
    "apps/desktop/scripts/blind-persona-seed-data.ts",
    "apps/desktop/scripts/prepare-blind-persona-workspaces.ts",
    "apps/desktop/scripts/prepare-blind-persona-workspaces-cli.mjs",
    "apps/desktop/scripts/launch-blind-persona-tester-cli.mjs",
    "apps/desktop/test-fixtures/job-finder/blind-personas/manifest.json",
    `apps/desktop/${blindManifest.jobCorpusPath}`,
    ...blindManifest.sessions.map(
      (session) => `apps/desktop/${session.resumeInput.path}`,
    ),
  ]
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .sort();
  return Promise.all(
    paths.map(async (relativePath) => {
      const bytes = await readFile(path.join(repositoryRoot, relativePath));
      return {
        bytes: bytes.byteLength,
        kind: "file",
        mode: 420,
        path: relativePath,
        sha256: sha256(bytes),
      };
    }),
  );
}

async function makeAcceptedRun(root: string) {
  const runDir = path.join(root, "production-acceptance-real-shape");
  const snapshotRoot = path.join(root, "production-acceptance-source");
  const artifactRoot = path.join(runDir, "accepted-app");
  const mainPath = path.join(artifactRoot, "out", "main", "index.cjs");
  await mkdir(path.dirname(mainPath), { recursive: true });
  await writeFile(mainPath, "production-main");
  await mkdir(path.join(artifactRoot, "out", "preload"), { recursive: true });
  await writeFile(
    path.join(artifactRoot, "out", "preload", "index.cjs"),
    "production-preload",
  );
  await mkdir(path.join(artifactRoot, "out", "renderer"), { recursive: true });
  await writeFile(
    path.join(artifactRoot, "out", "renderer", "index.html"),
    "<html>production</html>",
  );
  const packageMetadata = {
    name: "@nestor/desktop",
    private: true,
    version: "0.1.0",
    main: "out/main/index.cjs",
  };
  await writeFile(
    path.join(artifactRoot, "package.json"),
    `${stableSeedSerialization(packageMetadata)}\n`,
  );
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "fresh-report.json"),
    "accepted evidence\n",
  );

  const artifactContents = {
    "out/main/index.cjs": "production-main",
    "out/preload/index.cjs": "production-preload",
    "out/renderer/index.html": "<html>production</html>",
  };
  const artifactFiles = Object.entries(artifactContents).map(
    ([artifactPath, contents]) => ({
      bytes: Buffer.byteLength(contents),
      kind: "file",
      path: artifactPath,
      sha256: sha256(contents),
    }),
  );
  const artifactDigest = sha256(
    artifactFiles
      .map((entry) => `${stableSeedSerialization(entry)}\n`)
      .join(""),
  );
  const roots = [
    { exists: true, fileCount: 3, path: "out" },
    { exists: false, fileCount: 0, path: "assets" },
    { exists: false, fileCount: 0, path: "dist/resume-parser-sidecar" },
  ];
  const capturedFiles = await acceptedLocalSources();
  const snapshotFiles = capturedFiles.map(({ mode, ...entry }) => ({
    ...entry,
    sourceMode: mode,
    snapshotMode: mode,
  }));
  const sourceDigest = sha256(
    snapshotFiles
      .map((entry) => `${stableSeedSerialization(entry)}\n`)
      .join(""),
  );
  const capturedDigest = sha256(
    capturedFiles
      .map((entry) => `${stableSeedSerialization(entry)}\n`)
      .join(""),
  );
  const evidenceBytes = await readFile(path.join(runDir, "fresh-report.json"));
  const acceptedAppFiles = [
    ...artifactFiles,
    {
      bytes: Buffer.byteLength(`${stableSeedSerialization(packageMetadata)}\n`),
      kind: "file",
      path: "package.json",
      sha256: sha256(`${stableSeedSerialization(packageMetadata)}\n`),
    },
  ].sort((left, right) => compareCodeUnitOrder(left.path, right.path));
  const acceptedAppDigest = sha256(
    acceptedAppFiles
      .map((entry) => `${stableSeedSerialization(entry)}\n`)
      .join(""),
  );
  const evidenceFiles = [
    {
      bytes: evidenceBytes.byteLength,
      component: "fresh",
      kind: "report",
      path: "fresh-report.json",
      sha256: sha256(evidenceBytes),
    },
    ...acceptedAppFiles.map((entry) => ({
      bytes: entry.bytes,
      component: "accepted-app",
      kind: "accepted-app-file",
      path: `accepted-app/${entry.path}`,
      sha256: entry.sha256,
    })),
  ];
  const base = {
    acceptanceVersion: 1,
    runDir,
    pass: false,
    snapshot: {
      root: snapshotRoot,
      capturedSourceDigest: capturedDigest,
      cleanedUp: true,
      digest: sourceDigest,
      dependencies: {
        roots: [],
        originalBeforeCopy: {
          digest: sha256(""),
          fileCount: 0,
          files: [],
        },
      },
    },
    source: {
      capturedWorktree: {
        algorithm: "sha256",
        digest: capturedDigest,
        fileCount: capturedFiles.length,
        files: capturedFiles,
        pathSetDigest: await currentSourcePathSetDigest(),
      },
      beforeBuild: {
        algorithm: "sha256",
        digest: sourceDigest,
        fileCount: snapshotFiles.length,
        files: snapshotFiles,
      },
      afterBuild: {
        algorithm: "sha256",
        digest: sourceDigest,
        fileCount: snapshotFiles.length,
        files: snapshotFiles,
      },
    },
    artifacts: {
      algorithm: "sha256",
      digest: artifactDigest,
      fileCount: artifactFiles.length,
      files: artifactFiles,
      roots,
    },
  };
  const manifestSha256 = sha256(stableSeedSerialization(base));
  const manifest = { ...base, manifestSha256 };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(runDir, "build-manifest.json"), manifestBytes);
  const report = {
    ...base,
    pass: true,
    completedAt: "2026-08-23T12:00:00.000Z",
    initialManifestSha256: manifestSha256,
    initialManifestFileSha256: sha256(manifestBytes),
    source: {
      ...base.source,
      postRun: {
        algorithm: "sha256",
        digest: sourceDigest,
        fileCount: snapshotFiles.length,
      },
    },
    artifacts: {
      ...base.artifacts,
      postRun: base.artifacts,
    },
    acceptedApp: {
      algorithm: "sha256",
      artifactDigest,
      artifactFileCount: artifactFiles.length,
      digest: acceptedAppDigest,
      fileCount: acceptedAppFiles.length,
      files: acceptedAppFiles,
      launch: {
        args: ["."],
        cwd: "accepted-app",
        main: "out/main/index.cjs",
      },
      packageMetadata,
      path: "accepted-app",
      readOnly: true,
      sourceDigest,
      verifiedAfterSnapshotCleanup: true,
    },
    evidence: {
      algorithm: "sha256",
      digest: sha256(stableSeedSerialization(evidenceFiles)),
      fileCount: evidenceFiles.length,
      files: evidenceFiles,
    },
  };
  await writeFile(
    path.join(runDir, "acceptance-report.json"),
    JSON.stringify(report),
  );
  const reportBytes = await readFile(
    path.join(runDir, "acceptance-report.json"),
  );
  const electronBytes = await readFile(process.execPath);
  const sealSubject = {
    schemaVersion: 1,
    digestRecipe: "sha256(canonical-json(final-seal-without-sealSha256))",
    threatModel:
      "Local hashes detect uncoordinated mutation. A coordinated owner rewrite of seal and subjects requires an externally custodied expectedSealSha256 or signature to detect.",
    runId: path.basename(runDir),
    runDir,
    sourceId: sourceDigest,
    artifactId: artifactDigest,
    initialBuildManifest: {
      rawSha256: sha256(manifestBytes),
      canonicalSha256: manifestSha256,
    },
    finalReport: {
      rawSha256: sha256(reportBytes),
      canonicalSha256: sha256(stableSeedSerialization(report)),
    },
    acceptedApp: {
      digest: acceptedAppDigest,
      fileCount: acceptedAppFiles.length,
    },
    evidence: {
      digest: report.evidence.digest,
      fileCount: evidenceFiles.length,
    },
    electron: {
      executablePath: process.execPath,
      bytes: electronBytes.byteLength,
      sha256: sha256(electronBytes),
    },
  };
  const expectedSealSha256 = sha256(stableSeedSerialization(sealSubject));
  await writeFile(
    path.join(runDir, "acceptance-seal.json"),
    JSON.stringify({ ...sealSubject, sealSha256: expectedSealSha256 }),
  );
  await Promise.all(
    [
      "acceptance-report.json",
      "build-manifest.json",
      "acceptance-seal.json",
      "fresh-report.json",
    ].map((name) => chmod(path.join(runDir, name), 0o444)),
  );
  await Promise.all(
    acceptedAppFiles.map((entry) =>
      chmod(path.join(artifactRoot, entry.path), 0o444),
    ),
  );
  await rm(snapshotRoot, { recursive: true, force: true });
  return {
    artifactRoot,
    expectedSealSha256,
    mainPath,
    report,
    runDir,
    snapshotRoot,
  };
}

function durableSnapshot(state: Record<string, unknown>) {
  const discovery = state.discovery as Record<string, unknown> | undefined;
  return {
    ...state,
    activeSourceDebugRun: discovery?.activeSourceDebugRun ?? null,
    applicationAttempts: state.applicationAttempts ?? [],
    applicationRecords: state.applicationRecords ?? [],
    applyJobResults: state.applyJobResults ?? [],
    applyRuns: state.applyRuns ?? [],
    campaignNotifications: state.campaignNotifications ?? [],
    campaigns: state.campaigns ?? [],
    discoveryJobs: state.savedJobs ?? [],
    // Keep the fixture's durable intelligence exactly as the production
    // snapshot does; P13's outcome events and batch safeguards are part of
    // restart parity, not disposable seed intent.
    intelligence: state.intelligence ?? {},
    resumeDrafts: state.resumeDrafts ?? [],
    resumeExportArtifacts: state.resumeExportArtifacts ?? [],
    recentSourceDebugRuns: discovery?.recentSourceDebugRuns ?? [],
    tailoredAssets: state.tailoredAssets ?? [],
    userActionEvents: state.userActionEvents ?? [],
    userActionRequests: state.userActionRequests ?? [],
  };
}

function runtimeLaunch(options: {
  exposeTesterApi?: boolean;
  materializeDerivedSetupState?: boolean;
  migrateResumeOnRestart?: boolean;
  mutateRestartIntelligence?: boolean;
  mutateRestart?: boolean;
  mutateRestartAt?: number;
  onEnvironment?: (env: NodeJS.ProcessEnv) => void;
}) {
  let saved: Record<string, unknown> | undefined;
  let lastRestartSnapshot: Record<string, unknown> | undefined;
  let launches = 0;
  const launch: LaunchSeedElectron = async ({ env }) => {
    launches += 1;
    options.onEnvironment?.(env);
    const isSeed = env.NESTOR_ENABLE_TEST_API === "1";
    const app: ElectronSeedProcess = {
      close: async () => undefined,
      firstWindow: async () => ({
        evaluate: async <R, A>(
          _callback: (argument: A) => R | Promise<R>,
          argument: A,
        ): Promise<R> => {
          if (isSeed) {
            const state = argument as Record<string, unknown>;
            const derivedSetupState = options.materializeDerivedSetupState
              ? deriveProfileSetupState(
                  CandidateProfileSchema.parse(state.profile),
                  JobSearchPreferencesSchema.parse(state.searchPreferences),
                  {
                    currentState: ProfileSetupStateSchema.parse(
                      state.profileSetupState,
                    ),
                  },
                )
              : null;
            const seededState = derivedSetupState
              ? {
                  ...state,
                  // Production adds these missing-field items during its
                  // startup read. Their timestamps are intentionally
                  // runtime-generated, so the harness must not require them
                  // in the pre-reset intent projection.
                  profileSetupState: {
                    ...derivedSetupState,
                    reviewItems: [
                      {
                        id: "derived-contact-review",
                        step: "essentials",
                        target: {
                          domain: "identity",
                          key: "contactPath",
                          recordId: null,
                        },
                        label: "Contact details",
                        reason: "Add a contact path.",
                        severity: "critical",
                        status: "pending",
                        proposedValue: null,
                        sourceSnippet: null,
                        sourceCandidateId: null,
                        sourceRunId: null,
                        createdAt: new Date().toISOString(),
                        resolvedAt: null,
                      },
                      {
                        id: "derived-work-history-review",
                        step: "background",
                        target: {
                          domain: "experience",
                          key: "record",
                          recordId: null,
                        },
                        label: "Work history",
                        reason: "Add work history.",
                        severity: "critical",
                        status: "pending",
                        proposedValue: null,
                        sourceSnippet: null,
                        sourceCandidateId: null,
                        sourceRunId: null,
                        createdAt: new Date().toISOString(),
                        resolvedAt: null,
                      },
                    ],
                  },
                }
              : state;
            saved = durableSnapshot(seededState);
            return saved as R;
          }
          const snapshot = structuredClone(saved!);
          if (options.migrateResumeOnRestart) {
            const userDataDirectory = env.NESTOR_USER_DATA_DIR;
            if (!userDataDirectory) {
              throw new Error("Runtime fixture is missing its user-data path.");
            }
            const repository = createInMemoryJobFinderRepository(
              createEmptyJobFinderRepositoryState(),
            );
            await repository.saveProfile(
              CandidateProfileSchema.parse(snapshot.profile),
            );
            await migrateLegacyResumeSource({
              documentsDirectory: path.join(
                userDataDirectory,
                "documents",
                "resumes",
              ),
              repository,
            });
            snapshot.profile = await repository.getProfile();
          }
          if (
            options.mutateRestart &&
            launches === (options.mutateRestartAt ?? 2)
          )
            snapshot.settings = { broken: true };
          if (
            options.mutateRestartIntelligence &&
            launches === (options.mutateRestartAt ?? 2)
          )
            snapshot.intelligence = {};
          lastRestartSnapshot = structuredClone(snapshot);
          return {
            snapshot,
            testApiPresent: options.exposeTesterApi === true,
          } as R;
        },
        waitForFunction: async () => undefined,
        waitForLoadState: async () => undefined,
      }),
      process: () => ({
        exitCode: 0,
        pid: 900_000 + launches,
        signalCode: null,
      }),
    };
    return app;
  };
  return {
    launch,
    get launches() {
      return launches;
    },
    get restartSnapshot() {
      return structuredClone(lastRestartSnapshot);
    },
  };
}

interface FakeCdpServer {
  readonly port: number;
  readonly requests: number;
  stop: () => Promise<void>;
}

async function startFakeCdpServer(options: {
  port: number;
  responseBody?: Record<string, unknown>;
  withRequiredKeys: boolean;
}): Promise<FakeCdpServer> {
  const state = { requests: 0 };
  const server = createHttpServer((_request, response) => {
    state.requests += 1;
    response.setHeader("content-type", "application/json");
    const responseBody =
      options.responseBody ??
      (options.withRequiredKeys
        ? {
            Browser: "fake/1",
            webSocketDebuggerUrl: `ws://127.0.0.1:${options.port}/devtools/browser/guid`,
          }
        : { unexpected: true });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  return {
    get requests() {
      return state.requests;
    },
    port: options.port,
    stop: async () => {
      (
        server as unknown as { closeAllConnections?: () => void }
      ).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A loopback port nothing listens on right now. Fixed numbers collided with
 * other test files and local apps when the whole suite ran at once. */
async function freeLoopbackPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string")
    throw new Error("The test server has no port.");
  return address.port;
}

function driverChannelLaunch(options: {
  cdpResponse?: (
    port: number,
    args: string[],
  ) => Record<string, unknown> | undefined;
  emitPorts: (args: string[]) => number | null;
  unkeyedPorts?: number[];
  filePortOverride?: (emittedPort: number) => number;
  omitDevToolsActivePortFile?: (emittedPort: number, args: string[]) => boolean;
}) {
  let saved: Record<string, unknown> | undefined;
  const launches: string[][] = [];
  const capturedEnvironments: NodeJS.ProcessEnv[] = [];
  const servers: FakeCdpServer[] = [];
  let counter = 0;
  const launch: LaunchSeedElectron = async ({ args, env }) => {
    counter += 1;
    launches.push([...args]);
    capturedEnvironments.push({ ...env });
    const emittedPort = options.emitPorts(args);
    if (emittedPort !== null) {
      // Chromium writes DevToolsActivePort into the user-data root once the
      // debug listener is live; the fake mirrors that plus a real endpoint.
      servers.push(
        await startFakeCdpServer({
          port: emittedPort,
          responseBody: options.cdpResponse?.(emittedPort, args),
          withRequiredKeys: !(options.unkeyedPorts ?? []).includes(emittedPort),
        }),
      );
      const filePort = options.filePortOverride?.(emittedPort) ?? emittedPort;
      if (!options.omitDevToolsActivePortFile?.(emittedPort, args)) {
        await writeFile(
          path.join(String(env.NESTOR_USER_DATA_DIR), "DevToolsActivePort"),
          `${filePort}\nws://127.0.0.1:${emittedPort}/devtools/browser/guid\n`,
          "utf8",
        );
      }
    }
    const launchIndex = counter;
    const probeFromEnvironment = () => {
      const width = Number(env.NESTOR_STARTUP_WINDOW_WIDTH ?? 1440);
      const height = Number(env.NESTOR_STARTUP_WINDOW_HEIGHT ?? 920);
      return {
        contentBounds: { x: 0, y: 0, width, height },
        displayMode: "normal",
        outerBounds: { x: 0, y: 0, width, height },
        zoomFactor: Number(env.NESTOR_STARTUP_ZOOM_FACTOR ?? 1),
      };
    };
    return {
      close: async () => undefined,
      evaluateInMain: async <R>(): Promise<R> =>
        structuredClone(probeFromEnvironment()) as R,
      firstWindow: async () => ({
        evaluate: async <R, A>(
          _callback: (argument: A) => R | Promise<R>,
          argument: A,
        ): Promise<R> => {
          if (env.NESTOR_ENABLE_TEST_API === "1") {
            saved = durableSnapshot(argument as Record<string, unknown>);
            return saved as R;
          }
          return {
            snapshot: structuredClone(saved!),
            testApiPresent: false,
          } as R;
        },
        waitForFunction: async () => undefined,
        waitForLoadState: async () => undefined,
      }),
      process: () => ({
        exitCode: 0,
        pid: 800_000 + launchIndex,
        signalCode: null,
      }),
    };
  };
  return {
    launch,
    async stop(): Promise<void> {
      for (const server of servers.splice(0)) await server.stop();
    },
    get capturedEnvironments() {
      return capturedEnvironments;
    },
    get launches() {
      return launches;
    },
    get servers() {
      return servers;
    },
  };
}

describe("blind persona accepted-build preparation", () => {
  it("selects fresh jobs by manifest corpus binding without P01-P12 branches", async () => {
    const source = await readFile(
      path.join(
        repositoryRoot,
        "apps/desktop/scripts/prepare-blind-persona-workspaces.ts",
      ),
      "utf8",
    );
    const buildStart = source.indexOf("async function buildPersonaState(");
    const buildEnd = source.indexOf("const defaultLaunch", buildStart);
    expect(buildStart).toBeGreaterThan(-1);
    expect(buildEnd).toBeGreaterThan(buildStart);
    const buildSource = source.slice(buildStart, buildEnd);

    expect(buildSource).toContain(
      "getBlindPersonaJobsForSession(data, session)",
    );
    expect(buildSource).not.toContain("jobsByPersona[personaId]");
    expect(buildSource).not.toMatch(
      /personaId\s*===\s*["']P(?:0[1-9]|1[0-2])["']/u,
    );
  });

  it("uses canonical paths and rejects aliases", () => {
    const root = path.join(approvedTempRoot, "personas");
    expect(isPathInside(root, path.join(root, "P01-a"))).toBe(true);
    expect(isPathInside(root, path.join(root, "..", "escape"))).toBe(false);
    expect(() => resolveConfinedPath(root, "a/../b")).toThrow(/canonical/u);
    expect(createUniquePersonaRoot(root, "P01", "one")).toBe(
      path.join(root, "P01-one"),
    );
  });

  it("fingerprints transitive dependency bytes, links, modes, and additions", async () => {
    const root = await uniqueTestRoot("blind-dependency-identity");
    const packageRoot = path.join(root, "node_modules/pkg");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "index.js"), "before");
    await symlink("index.js", path.join(packageRoot, "entry.js"));
    const before = await dependencyIdentity(root, ["node_modules"]);
    await writeFile(path.join(packageRoot, "index.js"), "after");
    const after = await dependencyIdentity(root, ["node_modules"]);
    expect(after.digest).not.toBe(before.digest);
    expect(before.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          path: "node_modules/pkg/index.js",
        }),
        expect.objectContaining({ kind: "symlink", target: "index.js" }),
      ]),
    );
  });

  // Cross-implementation custody parity: the acceptance harness seals
  // dependencyRootsFingerprint output (report.snapshot.dependencies.
  // originalBeforeCopy) while this seeder recomputes dependencyIdentity over
  // the live workspace. With multiple nonempty roots the verifier must emit
  // ONE globally ordered inventory — full-path code-unit order — with exactly
  // the producer's files array order and digest, or a mixed-case/non-ASCII
  // toolchain tree would fail verifyAcceptedBuild on ordering alone.
  it("recomputes the acceptance producer's sealed dependency identity byte-identically across roots", async () => {
    const fixtureRoot = await uniqueTestRoot(
      "blind-dependency-producer-parity",
    );
    const rootA = path.join(fixtureRoot, "node_modules", "pkg-a");
    const rootB = path.join(
      fixtureRoot,
      "apps",
      "desktop",
      "node_modules",
      "pkg-b",
    );
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(path.join(rootA, "Zeta.txt"), "pkg-a-zeta\n");
    await writeFile(path.join(rootA, "alpha.txt"), "pkg-a-alpha\n");
    await symlink("alpha.txt", path.join(rootA, "linked.txt"));
    await writeFile(path.join(rootB, "Beta.txt"), "pkg-b-beta\n");
    await writeFile(path.join(rootB, "Änderung.txt"), "pkg-b-aenderung\n");
    const relativeRoots = ["node_modules", "apps/desktop/node_modules"];
    const producer = await dependencyRootsFingerprint(
      fixtureRoot,
      relativeRoots,
    );
    const verifier = await dependencyIdentity(fixtureRoot, relativeRoots);
    // Stored root metadata keeps its input order; only the merged file
    // inventory is canonically ordered.
    expect(producer.roots.map((root) => root.path)).toEqual(relativeRoots);
    const expectedOrder = [
      "apps/desktop/node_modules/pkg-b/Beta.txt",
      "apps/desktop/node_modules/pkg-b/Änderung.txt",
      "node_modules/pkg-a/Zeta.txt",
      "node_modules/pkg-a/alpha.txt",
      "node_modules/pkg-a/linked.txt",
    ];
    expect(producer.files.map((entry) => entry.path)).toEqual(expectedOrder);
    expect(verifier.fileCount).toBe(producer.fileCount);
    expect(verifier.digest).toBe(producer.digest);
    // Exact array order and record-for-record byte identity, as
    // verifyAcceptedBuild compares them.
    expect(stableSeedSerialization(verifier.files)).toBe(
      stableSeedSerialization(producer.files),
    );
    expect(verifier.files.map((entry) => String(entry.path))).toEqual(
      expectedOrder,
    );
    // Fixture guard: this multi-root interleaving genuinely diverges from
    // ambient collation, so a localeCompare regression fails this test.
    const localeOrder = [...expectedOrder].sort(
      new Intl.Collator("en").compare,
    );
    expect(localeOrder).not.toEqual(expectedOrder);
  });

  it("uses a minimal allowlist and clears broad secrets, provider config, home, and proxies", () => {
    const ambient = {
      PATH: "/bin",
      HOME: "/secret/home",
      AWS_SESSION_TOKEN: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/secret/google.json",
      OPENAI_API_KEY: "secret",
      HTTP_PROXY: "http://proxy",
      npm_config_userconfig: "/secret/npmrc",
      P12_PATH: "/secret/cert.p12",
      COOKIE_JAR: "secret",
    };
    const seeded = hardenSeedEnvironment(ambient, "/owned/P01");
    const tester = hardenTesterEnvironment(ambient, "/owned/P01");
    expect(seeded.PATH).toBe("/bin");
    expect(seeded.NESTOR_ENABLE_TEST_API).toBe("1");
    expect(tester.NESTOR_ENABLE_TEST_API).toBeUndefined();
    for (const key of Object.keys(ambient).filter((key) => key !== "PATH")) {
      expect(tester[key]).toBeUndefined();
    }
    expect(tester.NESTOR_BROWSER_AGENT).toBe("0");
  });

  it("distinguishes local user-recorded Applied from submitted evidence and scans broad authority", () => {
    expect(
      scanSeedAuthority({
        applicationRecords: [{ stage: "applied", source: "user_recorded" }],
        expectedAuthority: { submitAuthorized: false },
      }),
    ).toEqual([]);
    expect(
      scanSeedAuthority({
        applicationAttempts: [{ status: "submitted", submittedAt: "now" }],
        externalWriteReceipts: [{ id: "receipt" }],
        credentials: "secret",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/submitted/u),
        expect.stringMatching(/submittedAt/u),
        expect.stringMatching(/externalWriteReceipts/u),
        expect.stringMatching(/credentials/u),
      ]),
    );
  });

  it("rejects foreign P##-UUID workspace paths while allowing the own root", () => {
    const ownRoot =
      "/private/tmp/personas/P13-550e8400-e29b-41d4-a716-446655440000";
    const foreignRoot =
      "/private/tmp/personas/P14-550e8400-e29b-41d4-a716-446655440000";
    const state = {
      profile: {
        baseResume: {
          storagePath: `${ownRoot}/documents/resumes/original.txt`,
        },
      },
      retainedCopy: `${foreignRoot}/persona-assets/resume/original.txt`,
    };

    expect(scanCrossPersonaPaths({ own: state.profile }, "P13")).toEqual([]);
    expect(scanCrossPersonaPaths(state, "P13")).toEqual(["retainedCopy"]);
  });

  it("consumes independently loaded real runner report/manifest shape", async () => {
    const fixture = await makeAcceptedRun(
      await uniqueTestRoot("blind-real-interface"),
    );
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
      }),
    ).resolves.toMatchObject({
      artifactRoot: fixture.artifactRoot,
      mainEntryPath: fixture.mainPath,
      acceptanceVersion: 1,
    });
  });

  it("requires the externally custodied final seal digest", async () => {
    const fixture = await makeAcceptedRun(
      await uniqueTestRoot("blind-final-seal-custody"),
    );
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/seal digest mismatch/u);
  });

  it("rejects a sealed Electron executable mismatch", async () => {
    const fixture = await makeAcceptedRun(
      await uniqueTestRoot("blind-electron-mismatch"),
    );
    const fakeElectron = path.join(fixture.runDir, "bound-electron");
    await writeFile(fakeElectron, "electron-before");
    const sealPath = path.join(fixture.runDir, "acceptance-seal.json");
    await chmod(sealPath, 0o644);
    const seal = JSON.parse(await readFile(sealPath, "utf8"));
    seal.electron = {
      executablePath: fakeElectron,
      bytes: Buffer.byteLength("electron-before"),
      sha256: sha256("electron-before"),
    };
    delete seal.sealSha256;
    seal.sealSha256 = sha256(stableSeedSerialization(seal));
    await writeFile(sealPath, JSON.stringify(seal));
    await chmod(sealPath, 0o444);
    await writeFile(fakeElectron, "electron-after");
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: seal.sealSha256,
      }),
    ).rejects.toThrow(/Electron executable differs/u);
  });

  it("rejects forged/stale run IDs and report-manifest swaps", async () => {
    const fixture = await makeAcceptedRun(
      await uniqueTestRoot("blind-forged-run"),
    );
    fixture.report.runDir = `${fixture.runDir}-forged`;
    await chmod(path.join(fixture.runDir, "acceptance-report.json"), 0o644);
    await writeFile(
      path.join(fixture.runDir, "acceptance-report.json"),
      JSON.stringify(fixture.report),
    );
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
      }),
    ).rejects.toThrow(/seal|run ID/u);
  });

  it("rejects seeder source bytes that differ from the accepted source inventory", async () => {
    const fixture = await makeAcceptedRun(
      await uniqueTestRoot("blind-source-mismatch"),
    );
    const manifestPath = path.join(fixture.runDir, "build-manifest.json");
    const reportPath = path.join(fixture.runDir, "acceptance-report.json");
    await Promise.all([chmod(manifestPath, 0o644), chmod(reportPath, 0o644)]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.source.capturedWorktree.files[0].sha256 = "d".repeat(64);
    manifest.source.capturedWorktree.digest = sha256(
      manifest.source.capturedWorktree.files
        .map(
          (entry: Record<string, unknown>) =>
            `${stableSeedSerialization(entry)}\n`,
        )
        .join(""),
    );
    manifest.snapshot.capturedSourceDigest =
      manifest.source.capturedWorktree.digest;
    delete manifest.manifestSha256;
    manifest.manifestSha256 = sha256(stableSeedSerialization(manifest));
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(manifestPath, manifestBytes);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.source.capturedWorktree = manifest.source.capturedWorktree;
    report.snapshot.capturedSourceDigest =
      manifest.snapshot.capturedSourceDigest;
    report.initialManifestSha256 = manifest.manifestSha256;
    report.initialManifestFileSha256 = sha256(manifestBytes);
    await writeFile(reportPath, JSON.stringify(report));
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
      }),
    ).rejects.toThrow(/seal|source bytes differ/u);
  });

  it("rejects extra, symlinked, and swapped accepted artifacts", async () => {
    const extra = await makeAcceptedRun(
      await uniqueTestRoot("blind-extra-artifact"),
    );
    await writeFile(path.join(extra.artifactRoot, "out", "extra.cjs"), "extra");
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: extra.runDir,
        expectedSealSha256: extra.expectedSealSha256,
      }),
    ).rejects.toThrow(/count|extra/u);

    const swapped = await makeAcceptedRun(
      await uniqueTestRoot("blind-swapped-artifact"),
    );
    await chmod(swapped.mainPath, 0o644);
    await writeFile(swapped.mainPath, "swapped-main");
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: swapped.runDir,
        expectedSealSha256: swapped.expectedSealSha256,
      }),
    ).rejects.toThrow(/bytes/u);

    const linked = await makeAcceptedRun(
      await uniqueTestRoot("blind-linked-artifact"),
    );
    await writeFile(
      path.join(linked.artifactRoot, "target.cjs"),
      "production-main",
    );
    await chmod(linked.mainPath, 0o644);
    await writeFile(linked.mainPath, "removed");
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(linked.mainPath),
    );
    await symlink(
      path.join(linked.artifactRoot, "target.cjs"),
      linked.mainPath,
    );
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: linked.runDir,
        expectedSealSha256: linked.expectedSealSha256,
      }),
    ).rejects.toThrow(/Symlinks/u);
  });

  it("rejects missing accepted package, main, preload, and renderer resources", async () => {
    for (const relativePath of [
      "package.json",
      "out/main/index.cjs",
      "out/preload/index.cjs",
      "out/renderer/index.html",
    ]) {
      const fixture = await makeAcceptedRun(
        await uniqueTestRoot(
          `blind-missing-${relativePath.replaceAll("/", "-")}`,
        ),
      );
      await rm(path.join(fixture.artifactRoot, relativePath));
      await expect(
        verifyAcceptedBuild({
          acceptanceRunDir: fixture.runDir,
          expectedSealSha256: fixture.expectedSealSha256,
        }),
      ).rejects.toThrow(/missing|extra|launch resource/u);
    }
  });

  it("rejects a physical symlink acceptance root", async () => {
    const root = await uniqueTestRoot("blind-physical-root");
    const fixture = await makeAcceptedRun(root);
    const alias = path.join(root, "run-alias");
    await symlink(fixture.runDir, alias);
    await expect(
      verifyAcceptedBuild({
        acceptanceRunDir: alias,
        expectedSealSha256: fixture.expectedSealSha256,
      }),
    ).rejects.toThrow(/Symlinked/u);
  });

  it("performs exactly one reset, production restart, custody seal, and generic P12 preparation", async () => {
    const root = await uniqueTestRoot("blind-durable-seed");
    const fixture = await makeAcceptedRun(root);
    const runtime = runtimeLaunch({
      onEnvironment: (env) => {
        expect(env.AWS_SESSION_TOKEN).toBeUndefined();
        expect(env.NESTOR_BROWSER_AGENT).toBe("0");
      },
    });
    const result = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P12"],
      },
      { launch: runtime.launch },
    );
    expect(runtime.launches).toBe(2);
    expect(result.custodyIndexPath).toBeTruthy();
    const manifest = JSON.parse(
      await readFile(result.prepared[0]!.seedManifestPath, "utf8"),
    );
    expect(manifest.processOwnership).toMatchObject({
      launchCount: 2,
      resetCount: 1,
    });
    expect(manifest.environmentIntent).toEqual({
      aiCalls: 0,
      browserAgent: false,
      externalWrites: 0,
      networkCalls: 0,
      socketTelemetryAvailable: false,
    });
    await expect(
      verifyPreparedPersonaWorkspace(
        result.prepared[0]!.userDataRoot,
        result.custodyIndexPath!,
      ),
    ).resolves.toMatchObject({
      personaId: "P12",
      runtimeVolatileFileCount: 0,
      runtimeVolatileSpecialEntries: [],
    });
  });

  it("keeps browser-managed DIPS sidecars out of the sealed payload while retaining normal files", async () => {
    const root = await uniqueTestRoot("blind-dips-sealed-payload");
    const fixture = await makeAcceptedRun(root);
    const runtime = runtimeLaunch({});
    const launch: LaunchSeedElectron = async (input) => {
      const userDataRoot = input.env.NESTOR_USER_DATA_DIR;
      if (!userDataRoot)
        throw new Error("Runtime fixture is missing its user-data path.");
      for (const relativePath of [
        "DIPS",
        "DIPS-shm",
        "DIPS-wal",
        "nested/DIPS-shm",
        "arbitrary-shm",
      ]) {
        const filePath = path.join(userDataRoot, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${relativePath}\n`);
      }
      return runtime.launch(input);
    };
    const result = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch },
    );
    const prepared = result.prepared[0]!;
    const manifest = JSON.parse(
      await readFile(prepared.seedManifestPath, "utf8"),
    ) as {
      contaminationProof: { excludedFiles: string[] };
      payloadInventory: { files: Array<{ path: string }> };
    };
    const sealedPaths = manifest.payloadInventory.files.map(
      (entry) => entry.path,
    );
    expect(sealedPaths).toContain("DIPS");
    expect(sealedPaths).toContain("nested/DIPS-shm");
    expect(sealedPaths).toContain("arbitrary-shm");
    expect(sealedPaths).not.toContain("DIPS-shm");
    expect(sealedPaths).not.toContain("DIPS-wal");
    expect(manifest.contaminationProof.excludedFiles).toEqual([
      "blind-persona-seed-manifest.json",
      "DIPS-shm",
      "DIPS-wal",
    ]);

    await rm(path.join(prepared.userDataRoot, "DIPS-shm"));
    await rm(path.join(prepared.userDataRoot, "DIPS-wal"));
    await writeFile(
      path.join(
        path.dirname(result.custodyIndexPath!),
        testerLaunchRecordName("P01"),
      ),
      "{}\n",
    );
    await expect(
      verifyPreparedPersonaWorkspace(
        prepared.userDataRoot,
        result.custodyIndexPath!,
      ),
    ).resolves.toMatchObject({ mode: "consumed" });

    await rm(path.join(prepared.userDataRoot, "DIPS"));
    await expect(
      verifyPreparedPersonaWorkspace(
        prepared.userDataRoot,
        result.custodyIndexPath!,
      ),
    ).rejects.toThrow(/missing or shadowed/u);
  });

  it.each(["P13", "P14"] as const)(
    "accepts persisted %s setup state derived during reset",
    async (personaId) => {
      const root = await uniqueTestRoot(
        `blind-${personaId.toLowerCase()}-derived-setup-state`,
      );
      const fixture = await makeAcceptedRun(root);
      const runtime = runtimeLaunch({
        materializeDerivedSetupState: true,
        migrateResumeOnRestart: true,
      });
      const result = await prepareBlindPersonaWorkspaces(
        {
          acceptanceRunDir: fixture.runDir,
          expectedSealSha256: fixture.expectedSealSha256,
          custodyRoot: path.join(root, "custody"),
          destinationRoot: path.join(root, "personas"),
          personaIds: [personaId],
        },
        { launch: runtime.launch },
      );
      expect(runtime.launches).toBe(2);
      const restartSnapshot = runtime.restartSnapshot;
      if (!restartSnapshot)
        throw new Error("Restart snapshot was not captured.");
      const restartProfile = CandidateProfileSchema.parse(
        restartSnapshot.profile,
      );
      const persistedResumePath = restartProfile.baseResume.storagePath;
      if (!persistedResumePath) {
        throw new Error("Returning persona resume was not persisted.");
      }
      expect(path.isAbsolute(persistedResumePath)).toBe(true);
      expect(
        path.relative(
          path.join(result.prepared[0]!.userDataRoot, "documents", "resumes"),
          persistedResumePath,
        ),
      ).not.toMatch(/^\.\./u);
      const persistedResumeBytes = await readFile(persistedResumePath);
      const personaInputResumePath = path.join(
        result.prepared[0]!.userDataRoot,
        "persona-assets",
        "resume",
        path.basename(persistedResumePath),
      );
      expect(persistedResumeBytes).toEqual(
        await readFile(personaInputResumePath),
      );
      expect(restartProfile.baseResume.sha256).toBe(
        sha256(persistedResumeBytes),
      );
      expect(restartProfile.baseResume.analysisWarnings).not.toContain(
        missingResumeSourceWarning,
      );
      if (personaId === "P13") {
        const intelligence = restartSnapshot.intelligence as Record<
          string,
          unknown
        >;
        expect(intelligence.outcomeEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "blind_p13_outcome_01" }),
          ]),
        );
        expect(
          ((intelligence.safeguards ?? {}) as Record<string, unknown>)
            .preparedBatchSampleReviews,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "blind_p13_batch_review" }),
          ]),
        );
      }
      await expect(
        verifyPreparedPersonaWorkspace(
          result.prepared[0]!.userDataRoot,
          result.custodyIndexPath!,
        ),
      ).resolves.toMatchObject({ personaId });
    },
  );

  it("quarantines restart semantic mismatch without deleting successful roots", async () => {
    const root = await uniqueTestRoot("blind-restart-mismatch");
    const fixture = await makeAcceptedRun(root);
    const runtime = runtimeLaunch({ mutateRestart: true });
    await expect(
      prepareBlindPersonaWorkspaces(
        {
          acceptanceRunDir: fixture.runDir,
          expectedSealSha256: fixture.expectedSealSha256,
          custodyRoot: path.join(root, "custody"),
          destinationRoot: path.join(root, "personas"),
          personaIds: ["P01"],
        },
        { launch: runtime.launch },
      ),
    ).rejects.toThrow(/quarantined or removed/u);
    await expect(
      (await import("node:fs/promises")).readdir(path.join(root, "personas")),
    ).resolves.toEqual([expect.stringMatching(/\.incomplete$/u)]);
  });

  it("quarantines a restart that loses P13 durable intelligence", async () => {
    const root = await uniqueTestRoot("blind-restart-intelligence-mismatch");
    const fixture = await makeAcceptedRun(root);
    const runtime = runtimeLaunch({ mutateRestartIntelligence: true });
    await expect(
      prepareBlindPersonaWorkspaces(
        {
          acceptanceRunDir: fixture.runDir,
          expectedSealSha256: fixture.expectedSealSha256,
          custodyRoot: path.join(root, "custody"),
          destinationRoot: path.join(root, "personas"),
          personaIds: ["P13"],
        },
        { launch: runtime.launch },
      ),
    ).rejects.toThrow(/quarantined or removed/u);
    await expect(
      (await import("node:fs/promises")).readdir(path.join(root, "personas")),
    ).resolves.toEqual([expect.stringMatching(/\.incomplete$/u)]);
  });

  it("rejects accepted renderer mutation during a seed launch", async () => {
    const root = await uniqueTestRoot("blind-launch-tree-mutation");
    const fixture = await makeAcceptedRun(root);
    const runtime = runtimeLaunch({});
    let mutated = false;
    const launch: LaunchSeedElectron = async (input) => {
      const app = await runtime.launch(input);
      if (!mutated) {
        mutated = true;
        await chmod(
          path.join(fixture.artifactRoot, "out/renderer/index.html"),
          0o644,
        );
        await writeFile(
          path.join(fixture.artifactRoot, "out/renderer/index.html"),
          "<html>mutated during launch</html>",
        );
      }
      return app;
    };
    await expect(
      prepareBlindPersonaWorkspaces(
        {
          acceptanceRunDir: fixture.runDir,
          expectedSealSha256: fixture.expectedSealSha256,
          custodyRoot: path.join(root, "custody"),
          destinationRoot: path.join(root, "personas"),
          personaIds: ["P01"],
        },
        { launch },
      ),
    ).rejects.toThrow(/quarantined or removed/u);
  });

  it("terminates and rechecks owned descendant processes after each launch", async () => {
    const root = await uniqueTestRoot("blind-descendant-cleanup");
    const fixture = await makeAcceptedRun(root);
    let saved: Record<string, unknown> | undefined;
    const childPids: number[] = [];
    const launch: LaunchSeedElectron = async ({ env }) => {
      // A long-lived descendant spawned the same way on every platform:
      // "/bin/sh" does not exist on Windows, so the spawn failed
      // asynchronously, left pid undefined, and the recheck below passed
      // without ever having a process to terminate.
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => undefined, 30_000)"],
        { stdio: "ignore" },
      );
      childPids.push(child.pid!);
      return {
        close: async () => undefined,
        firstWindow: async () => ({
          evaluate: async <R, A>(
            _callback: (argument: A) => R | Promise<R>,
            argument: A,
          ): Promise<R> => {
            if (env.NESTOR_ENABLE_TEST_API === "1") {
              saved = durableSnapshot(argument as Record<string, unknown>);
              return saved as R;
            }
            return { snapshot: saved, testApiPresent: false } as R;
          },
          waitForFunction: async () => undefined,
          waitForLoadState: async () => undefined,
        }),
        process: () => ({ exitCode: null, pid: child.pid, signalCode: null }),
      };
    };
    await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch },
    );
    for (const pid of childPids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("preserves successful sealed roots and writes incomplete-wave custody when a later persona fails", async () => {
    const root = await uniqueTestRoot("blind-partial-wave");
    const fixture = await makeAcceptedRun(root);
    const runtime = runtimeLaunch({ mutateRestart: true, mutateRestartAt: 4 });
    await expect(
      prepareBlindPersonaWorkspaces(
        {
          acceptanceRunDir: fixture.runDir,
          expectedSealSha256: fixture.expectedSealSha256,
          custodyRoot: path.join(root, "custody"),
          destinationRoot: path.join(root, "personas"),
          personaIds: ["P01", "P02"],
        },
        { launch: runtime.launch },
      ),
    ).rejects.toThrow(/incomplete-wave custody/u);
    const roots = await (
      await import("node:fs/promises")
    ).readdir(path.join(root, "personas"));
    expect(roots).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^P01-(?!.*\.incomplete$)/u),
        expect.stringMatching(/^P02-.*\.incomplete$/u),
      ]),
    );
    const custody = JSON.parse(
      await readFile(
        path.join(root, "custody", "blind-persona-wave-custody-index.json"),
        "utf8",
      ),
    );
    expect(custody).toMatchObject({ waveComplete: false });
  });

  it("detects coordinated persona payload+manifest tampering against separate custody", async () => {
    const root = await uniqueTestRoot("blind-custody-tamper");
    const fixture = await makeAcceptedRun(root);
    const result = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const prepared = result.prepared[0]!;
    await writeFile(
      path.join(prepared.userDataRoot, "tampered.txt"),
      "tampered",
    );
    const manifest = JSON.parse(
      await readFile(prepared.seedManifestPath, "utf8"),
    );
    manifest.payloadInventory = await inventoryTree(
      prepared.userDataRoot,
      new Set(["blind-persona-seed-manifest.json"]),
    );
    const subject = { ...manifest };
    delete subject.seedManifestSha256;
    manifest.seedManifestSha256 = sha256(stableSeedSerialization(subject));
    await (
      await import("node:fs/promises")
    ).chmod(prepared.seedManifestPath, 0o644);
    await writeFile(prepared.seedManifestPath, JSON.stringify(manifest));
    await expect(
      verifyPreparedPersonaWorkspace(
        prepared.userDataRoot,
        result.custodyIndexPath!,
      ),
    ).rejects.toThrow(/custody/u);
  });

  it("enforced tester launch rejects test API and records custody-bound safe ownership", async () => {
    const root = await uniqueTestRoot("blind-tester-launch");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    await expect(
      launchBlindPersonaTester(
        { custodyIndexPath: prepared.custodyIndexPath!, personaId: "P01" },
        { launch: runtimeLaunch({ exposeTesterApi: true }).launch },
      ),
    ).rejects.toThrow(/test preload/u);

    // The failed attempt left an immutable intent, so the successful relaunch
    // continues with the next attempt instead of reusing attempt 1.
    const tester = await launchBlindPersonaTester(
      {
        attempt: 2,
        custodyIndexPath: prepared.custodyIndexPath!,
        personaId: "P01",
      },
      { launch: runtimeLaunch({}).launch },
    );
    const record = JSON.parse(await readFile(tester.launchRecordPath, "utf8"));
    expect(record.environment.NESTOR_ENABLE_TEST_API).toBeUndefined();
    expect(record.intent.socketTelemetryAvailable).toBe(false);
    expect(tester.testerBrief).toMatchObject({
      kind: "blind-persona-tester-brief",
      routeFreedom: "outcome_only",
      schemaVersion: 1,
    });
    expect(tester.testerBrief.postJourneyCheckpoint).toContain(
      "POST-JOURNEY OPTIONAL CHECKPOINT",
    );
    expect(record.testerBrief).toEqual(tester.testerBrief);
    const intent = JSON.parse(
      await readFile(
        path.join(
          path.dirname(tester.launchRecordPath),
          testerLaunchIntentName("P01", 2),
        ),
        "utf8",
      ),
    );
    expect(intent.testerBrief).toEqual(tester.testerBrief);
    await expect(tester.close()).resolves.toMatchObject({
      survivorsAfterCleanup: [],
    });
  });

  function geometryProbeLaunch(options: { probe?: unknown }) {
    let saved: Record<string, unknown> | undefined;
    const environments: NodeJS.ProcessEnv[] = [];
    let launches = 0;
    const launch: LaunchSeedElectron = async ({ env }) => {
      launches += 1;
      environments.push({ ...env });
      return {
        close: async () => undefined,
        evaluateInMain: async <R>(): Promise<R> =>
          structuredClone(options.probe) as R,
        firstWindow: async () => ({
          evaluate: async (): Promise<{
            snapshot: Record<string, unknown> | undefined;
            testApiPresent: boolean;
          }> => ({
            snapshot: structuredClone(saved!),
            testApiPresent: false,
          }),
          waitForFunction: async () => undefined,
          waitForLoadState: async () => undefined,
        }),
        process: () => ({
          exitCode: 0,
          pid: 700_000 + launches,
          signalCode: null,
        }),
      };
    };
    return {
      environments,
      get launchCount() {
        return launches;
      },
      launch,
    };
  }

  const fullMatchProbe = {
    contentBounds: { x: 0, y: 0, width: 1280, height: 800 },
    displayMode: "normal",
    outerBounds: { x: 0, y: 0, width: 1280, height: 800 },
    zoomFactor: 2,
  };

  it("injects the tester marker and geometry after hardening and records requested vs applied truth", async () => {
    const root = await uniqueTestRoot("blind-startup-geometry");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    const probed = geometryProbeLaunch({ probe: fullMatchProbe });
    const session = await launchBlindPersonaTester(
      {
        custodyIndexPath,
        personaId: "P01",
        startupWindowHeight: 800,
        startupWindowWidth: 1280,
        startupZoomFactor: 2,
      },
      { launch: probed.launch },
    );
    const record = JSON.parse(await readFile(session.launchRecordPath, "utf8"));
    expect(record.startupGeometry).toEqual({
      injected: true,
      requested: { windowHeight: 800, windowWidth: 1280, zoomFactor: 2 },
      applied: {
        contentBounds: { x: 0, y: 0, width: 1280, height: 800 },
        contentBoundsMatchRequest: true,
        displayMode: "normal",
        divergences: [],
        outerBounds: { x: 0, y: 0, width: 1280, height: 800 },
        outerBoundsMatchRequest: true,
        zoomFactor: 2,
        zoomFactorMatchesRequest: true,
      },
    });
    expect(probed.environments[0]?.NESTOR_TESTER_SESSION_GEOMETRY).toBe(
      "1",
    );
    expect(probed.environments[0]?.NESTOR_STARTUP_WINDOW_WIDTH).toBe(
      "1280",
    );
    expect(probed.environments[0]?.NESTOR_STARTUP_WINDOW_HEIGHT).toBe(
      "800",
    );
    expect(probed.environments[0]?.NESTOR_STARTUP_ZOOM_FACTOR).toBe("2");
    // Hardening stays intact around the explicitly injected keys.
    expect(record.environment.NESTOR_ENABLE_TEST_API).toBeUndefined();
    expect(record.environment.NESTOR_BROWSER_AGENT).toBe("0");
    // The final record references the immutable intent written before the
    // first spawn, and that intent carries a valid self-digest.
    const intent = JSON.parse(await readFile(record.launchIntent.path, "utf8"));
    expect(path.basename(record.launchIntent.path)).toBe(
      testerLaunchIntentName("P01"),
    );
    expect(record.launchIntent.sha256).toBe(intent.intentSha256);
    expect(intent.personaId).toBe("P01");
    expect(intent.attempt).toBe(1);
    expect(intent.requestedGeometry).toEqual({
      windowHeight: 800,
      windowWidth: 1280,
      zoomFactor: 2,
    });
    expect(intent.zeroNetwork.proxyArg).toBe("--proxy-server=127.0.0.1:9");
    const intentSubject = { ...intent };
    delete intentSubject.intentSha256;
    expect(sha256(stableSeedSerialization(intentSubject))).toBe(
      intent.intentSha256,
    );
    await session.close();

    // Without flags nothing is injected (marker included), even when the
    // ambient environment carries stray marker/startup values.
    process.env.NESTOR_TESTER_SESSION_GEOMETRY = "1";
    process.env.NESTOR_STARTUP_WINDOW_WIDTH = "99999";
    process.env.NESTOR_STARTUP_ZOOM_FACTOR = "4";
    try {
      const plainSession = await launchBlindPersonaTester(
        { attempt: 2, custodyIndexPath, personaId: "P01" },
        { launch: runtimeLaunch({}).launch },
      );
      const plainRecord = JSON.parse(
        await readFile(plainSession.launchRecordPath, "utf8"),
      );
      expect(plainRecord.startupGeometry).toEqual({ injected: false });
      for (const key of Object.keys(plainRecord.environment)) {
        expect(key.startsWith("NESTOR_STARTUP_")).toBe(false);
        expect(key).not.toBe("NESTOR_TESTER_SESSION_GEOMETRY");
      }
      const plainIntent = JSON.parse(
        await readFile(plainRecord.launchIntent.path, "utf8"),
      );
      expect(plainIntent.requestedGeometry).toBeNull();
      await plainSession.close();
    } finally {
      delete process.env.NESTOR_TESTER_SESSION_GEOMETRY;
      delete process.env.NESTOR_STARTUP_WINDOW_WIDTH;
      delete process.env.NESTOR_STARTUP_ZOOM_FACTOR;
    }
  });

  it("reports honest requested-vs-applied divergence without claiming clamps", () => {
    const diverged = summarizeTesterStartupGeometryApplied(
      { windowHeight: 100, windowWidth: 5000, zoomFactor: 2 },
      {
        contentBounds: { x: 0, y: 0, width: 1920, height: 400 },
        displayMode: "normal",
        outerBounds: { x: 0, y: 0, width: 1920, height: 400 },
        zoomFactor: 2,
      },
    );
    expect(diverged.outerBoundsMatchRequest).toBe(false);
    expect(diverged.contentBoundsMatchRequest).toBe(false);
    expect(diverged.zoomFactorMatchesRequest).toBe(true);
    expect(diverged.divergences).toEqual([
      "applied outer width 1920 differs from requested 5000",
      "applied outer height 400 differs from requested 100",
      "applied content width 1920 differs from requested 5000",
      "applied content height 400 differs from requested 100",
    ]);

    const exact = summarizeTesterStartupGeometryApplied(
      { windowHeight: 800, windowWidth: 1280, zoomFactor: 2 },
      {
        contentBounds: { x: 0, y: 0, width: 1280, height: 800 },
        displayMode: "normal",
        outerBounds: { x: 5, y: 7, width: 1280, height: 800 },
        zoomFactor: 2,
      },
    );
    expect(exact.divergences).toEqual([]);
    expect(exact.outerBoundsMatchRequest).toBe(true);
    expect(exact.contentBoundsMatchRequest).toBe(true);

    // Dimension-only requests leave every zoom verdict null (nothing to
    // compare); zoom-only requests produce boolean verdicts only for zoom.
    const dimensionOnly = summarizeTesterStartupGeometryApplied(
      { windowHeight: 800, windowWidth: 1280 },
      {
        contentBounds: { x: 0, y: 0, width: 1280, height: 800 },
        displayMode: "normal",
        outerBounds: { x: 0, y: 0, width: 1280, height: 800 },
        zoomFactor: 1.75,
      },
    );
    expect(dimensionOnly.zoomFactorMatchesRequest).toBeNull();
    expect(dimensionOnly.outerBoundsMatchRequest).toBe(true);
    expect(dimensionOnly.zoomFactor).toBe(1.75);
    expect(dimensionOnly.divergences).toEqual([]);

    // Zoom-only requests leave dimension matching vacuously true; an
    // unqueryable probe records notes instead of pretending success.
    const zoomOnly = summarizeTesterStartupGeometryApplied(
      { zoomFactor: 3 },
      {
        contentBounds: { x: 0, y: 0, width: 1440, height: 920 },
        displayMode: "maximized",
        outerBounds: { x: 0, y: 0, width: 1440, height: 920 },
        zoomFactor: 1.5,
      },
    );
    expect(zoomOnly.outerBoundsMatchRequest).toBe(true);
    expect(zoomOnly.contentBoundsMatchRequest).toBe(true);
    expect(zoomOnly.zoomFactorMatchesRequest).toBe(false);
    expect(zoomOnly.displayMode).toBe("maximized");
    expect(zoomOnly.divergences).toEqual([
      "applied zoom factor 1.5 differs from requested 3",
    ]);
    const unqueryable = summarizeTesterStartupGeometryApplied(
      { windowWidth: 800 },
      {},
    );
    expect(unqueryable.outerBounds).toBeNull();
    expect(unqueryable.outerBoundsMatchRequest).toBe(false);
    expect(unqueryable.zoomFactorMatchesRequest).toBeNull();
    expect(unqueryable.divergences).toContain(
      "outer bounds were not queryable",
    );
    const unqueryableZoom = summarizeTesterStartupGeometryApplied(
      { zoomFactor: 2 },
      { outerBounds: { width: 1280, height: 800 } },
    );
    expect(unqueryableZoom.zoomFactorMatchesRequest).toBe(false);
    expect(unqueryableZoom.divergences).toContain(
      "zoom factor was not queryable",
    );
  });

  it("fails closed when applied geometry cannot be measured and preserves the domain error", async () => {
    const root = await uniqueTestRoot("blind-geometry-probe-failure");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const tamperingClose: LaunchSeedElectron = async ({ cwd }) => ({
      close: async () => {
        // Simulate sealed-artifact drift surfacing during failure cleanup;
        // the fixture seals artifacts read-only, so unlock before writing.
        const mainEntry = path.join(cwd, "out/main/index.cjs");
        await chmod(mainEntry, 0o644);
        await writeFile(mainEntry, "tampered");
      },
      evaluateInMain: async <R>(): Promise<R> =>
        Promise.reject(new Error("probe failure injected") as R),
      firstWindow: async () => ({
        evaluate: async () => ({ snapshot: {}, testApiPresent: false }),
        waitForFunction: async () => undefined,
        waitForLoadState: async () => undefined,
      }),
      process: () => ({ exitCode: null, pid: 750_001, signalCode: null }),
    });
    let caught: unknown;
    try {
      await launchBlindPersonaTester(
        {
          custodyIndexPath: prepared.custodyIndexPath!,
          personaId: "P01",
          startupZoomFactor: 2,
        },
        { launch: tamperingClose },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const failure = caught as Error & { cause?: Error };
    // The original domain error survives verbatim in message and cause.
    expect(failure.message).toContain("probe failure injected");
    expect(failure.cause?.message ?? "").toContain("probe failure injected");
    // Cleanup integrity problems are aggregated, never masked silently.
    expect(failure.message).toMatch(/accepted-app re-check failed/u);
    expect(failure.message).toMatch(/tester failure cleanup reported/u);
  });

  it("records zoom-only requests without touching restored-bounds authority", async () => {
    const root = await uniqueTestRoot("blind-startup-zoom-only");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const probed = geometryProbeLaunch({
      probe: {
        contentBounds: { x: 4, y: 6, width: 1440, height: 920 },
        displayMode: "normal",
        outerBounds: { x: 4, y: 6, width: 1440, height: 920 },
        zoomFactor: 2,
      },
    });
    const session = await launchBlindPersonaTester(
      {
        custodyIndexPath: prepared.custodyIndexPath!,
        personaId: "P01",
        startupZoomFactor: 2,
      },
      { launch: probed.launch },
    );
    const record = JSON.parse(await readFile(session.launchRecordPath, "utf8"));
    expect(record.startupGeometry.injected).toBe(true);
    expect(record.startupGeometry.requested).toEqual({ zoomFactor: 2 });
    expect(Object.keys(record.startupGeometry.requested)).toEqual([
      "zoomFactor",
    ]);
    expect(record.startupGeometry.applied.outerBoundsMatchRequest).toBe(true);
    expect(record.startupGeometry.applied.zoomFactorMatchesRequest).toBe(true);
    expect(
      probed.environments[0]?.NESTOR_STARTUP_WINDOW_WIDTH,
    ).toBeUndefined();
    expect(
      probed.environments[0]?.NESTOR_STARTUP_WINDOW_HEIGHT,
    ).toBeUndefined();
    expect(probed.environments[0]?.NESTOR_STARTUP_ZOOM_FACTOR).toBe("2");
    expect(probed.environments[0]?.NESTOR_TESTER_SESSION_GEOMETRY).toBe(
      "1",
    );
    await session.close();
  });

  it("shares startup geometry environment across driver CDP ephemeral and fallback attempts", async () => {
    const root = await uniqueTestRoot("blind-driver-geometry-env");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const ephemeralPort = await freeLoopbackPort();
    const mixed = driverChannelLaunch({
      emitPorts: (args) => {
        if (args.includes("--remote-debugging-port=0")) return ephemeralPort;
        const requested = args
          .map((arg) => /--remote-debugging-port=(\d+)/u.exec(arg)?.[1])
          .find(Boolean);
        const port = Number(requested);
        return requested && port > 0 ? port : null;
      },
      unkeyedPorts: [ephemeralPort],
    });
    try {
      const session = await launchBlindPersonaTester(
        {
          custodyIndexPath: prepared.custodyIndexPath!,
          driverCdp: true,
          personaId: "P01",
          startupWindowHeight: 800,
          startupWindowWidth: 1280,
          startupZoomFactor: 2,
        },
        { driverTimeoutMs: 300, launch: mixed.launch },
      );
      expect(mixed.launches).toHaveLength(2);
      expect(mixed.capturedEnvironments).toHaveLength(2);
      for (const env of mixed.capturedEnvironments) {
        expect(env.NESTOR_TESTER_SESSION_GEOMETRY).toBe("1");
        expect(env.NESTOR_STARTUP_WINDOW_WIDTH).toBe("1280");
        expect(env.NESTOR_STARTUP_WINDOW_HEIGHT).toBe("800");
        expect(env.NESTOR_STARTUP_ZOOM_FACTOR).toBe("2");
        expect(env.NESTOR_ENABLE_TEST_API).toBeUndefined();
        expect(env.NESTOR_BROWSER_AGENT).toBe("0");
      }
      for (const args of mixed.launches) {
        expect(args).toContain("--proxy-server=127.0.0.1:9");
        expect(args).toContain(
          "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost",
        );
      }
      expect(session.driverChannel.resolution).toBe(
        "fixed-high-random-port-devtools-active-port-file",
      );
      const record = JSON.parse(
        await readFile(session.launchRecordPath, "utf8"),
      );
      expect(record.startupGeometry.applied.zoomFactorMatchesRequest).toBe(
        true,
      );
      await session.close();
    } finally {
      await mixed.stop();
    }
  });

  it("lets a valid archived intent relax consumed-mode verification while forged intents fail closed", async () => {
    const root = await uniqueTestRoot("blind-launch-intent-evidence");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01", "P02", "P03"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    const [first, second, third] = prepared.prepared;

    // Spawned-but-failed attempt (window opened, then the test API gate hit):
    // the intent already exists and no final record does.
    await expect(
      launchBlindPersonaTester(
        { custodyIndexPath, personaId: "P01" },
        { launch: runtimeLaunch({ exposeTesterApi: true }).launch },
      ),
    ).rejects.toThrow(/test preload/u);
    const intentPath = path.join(
      path.dirname(custodyIndexPath),
      testerLaunchIntentName("P01"),
    );
    await expect(readFile(intentPath, "utf8")).resolves.toMatch(
      /"kind": "blind-persona-tester-launch-intent"/u,
    );

    // Drift that strict mode would refuse is tolerated because the valid
    // intent proves a prior launched session consumed the workspace.
    await chmod(
      path.join(first!.userDataRoot, "persona-assets", "jobs.json"),
      0o644,
    );
    await writeFile(
      path.join(first!.userDataRoot, "persona-assets", "jobs.json"),
      '{"drifted":true}\n',
    );
    await expect(
      verifyPreparedPersonaWorkspace(first!.userDataRoot, custodyIndexPath),
    ).resolves.toMatchObject({
      decidedBy: intentPath,
      mode: "consumed",
    });

    // A failure BEFORE the intent write leaves no evidence: strict holds.
    await expect(
      launchBlindPersonaTester(
        { custodyIndexPath, personaId: "P02", startupZoomFactor: 9 },
        { launch: runtimeLaunch({}).launch },
      ),
    ).rejects.toThrow(/between 1 and 5/u);
    const secondIntentPath = path.join(
      path.dirname(custodyIndexPath),
      testerLaunchIntentName("P02"),
    );
    await expect(readFile(secondIntentPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await chmod(
      path.join(second!.userDataRoot, "persona-assets", "jobs.json"),
      0o644,
    );
    await writeFile(
      path.join(second!.userDataRoot, "persona-assets", "jobs.json"),
      '{"drifted":true}\n',
    );
    await expect(
      verifyPreparedPersonaWorkspace(second!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/Sealed workspace entry changed/u);

    // A forged cross-persona intent must never relax verification, even with
    // byte-intact sealed entries.
    const forged: Record<string, unknown> = {
      schemaVersion: 1,
      kind: "blind-persona-tester-launch-intent",
      personaId: "P04",
      attempt: 1,
      createdAtUtc: new Date().toISOString(),
      custodyIndexPath: path.resolve(custodyIndexPath),
      build: { finalSealSha256: fixture.expectedSealSha256 },
      seed: {},
      driverCdp: false,
      zeroNetwork: {},
    };
    forged.intentSha256 = sha256(stableSeedSerialization(forged));
    const forgedPath = path.join(
      path.dirname(custodyIndexPath),
      testerLaunchIntentName("P03"),
    );
    await writeFile(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);
    await expect(
      verifyPreparedPersonaWorkspace(third!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/belongs to persona P04/u);

    // A tampered payload fails its self-digest instead of relaxing anything.
    const tampered = { ...forged, attempt: 3 };
    await chmod(forgedPath, 0o644);
    await writeFile(forgedPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(
      verifyPreparedPersonaWorkspace(third!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/self-digest check/u);
  });

  it("wraps a duplicate immutable launch intent as an attempt-increment signal", async () => {
    const root = await uniqueTestRoot("blind-intent-eexist");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    const first = await launchBlindPersonaTester(
      { custodyIndexPath, personaId: "P01" },
      { launch: geometryProbeLaunch({ probe: fullMatchProbe }).launch },
    );
    await first.close();

    let caught: unknown;
    try {
      await launchBlindPersonaTester(
        { custodyIndexPath, personaId: "P01" },
        { launch: geometryProbeLaunch({ probe: fullMatchProbe }).launch },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const failure = caught as Error & { cause?: NodeJS.ErrnoException };
    expect(failure.message).toMatch(/immutable tester launch intent/iu);
    expect(failure.message).toMatch(/increment --attempt/u);
    // The original errno rides along as cause; nothing was overwritten.
    expect(failure.cause?.code).toBe("EEXIST");
    const recordNames = (await readdir(path.dirname(custodyIndexPath))).filter(
      (entry) => entry.startsWith("P01-"),
    );
    expect(recordNames).toEqual([
      testerLaunchIntentName("P01"),
      testerLaunchRecordName("P01"),
    ]);
  });

  it("validates archived intents against a renamed caller-provided custody index", async () => {
    const root = await uniqueTestRoot("blind-intent-renamed-index");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const originalIndexPath = prepared.custodyIndexPath!;
    const renamedIndexPath = path.join(
      path.dirname(originalIndexPath),
      "renamed-wave-custody-index.json",
    );
    await rename(originalIndexPath, renamedIndexPath);

    // Spawned-but-failed attempt bound to the renamed index path.
    await expect(
      launchBlindPersonaTester(
        { custodyIndexPath: renamedIndexPath, personaId: "P01" },
        { launch: runtimeLaunch({ exposeTesterApi: true }).launch },
      ),
    ).rejects.toThrow(/test preload/u);

    await chmod(
      path.join(
        prepared.prepared[0]!.userDataRoot,
        "persona-assets",
        "jobs.json",
      ),
      0o644,
    );
    await writeFile(
      path.join(
        prepared.prepared[0]!.userDataRoot,
        "persona-assets",
        "jobs.json",
      ),
      '{"drifted":true}\n',
    );
    // Verification follows the actual provided path (not a hardcoded file
    // name) and still recognizes the archived intent as launch evidence.
    await expect(
      verifyPreparedPersonaWorkspace(
        prepared.prepared[0]!.userDataRoot,
        renamedIndexPath,
      ),
    ).resolves.toMatchObject({
      decidedBy: path.join(
        path.dirname(renamedIndexPath),
        testerLaunchIntentName("P01"),
      ),
      mode: "consumed",
    });
  });

  it("keeps launch intent names attempt-specific and disjoint from final records", () => {
    expect(testerLaunchIntentName("P12")).toBe(
      "P12-blind-persona-tester-launch-intent.json",
    );
    expect(testerLaunchIntentName("P12", 3)).toBe(
      "P12-blind-persona-tester-launch-intent-attempt-3.json",
    );
    expect(testerLaunchRecordName("P12")).not.toBe(
      testerLaunchIntentName("P12"),
    );
    expect(testerLaunchIntentName("P12", 4)).not.toBe(
      testerLaunchRecordName("P12", 4),
    );
    expect(() => testerLaunchIntentName("P12", 0)).toThrow(/integer >= 1/u);
  });

  it("fails closed on partial or out-of-range tester startup geometry before launching", async () => {
    const root = await uniqueTestRoot("blind-startup-geometry-invalid");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const runtime = runtimeLaunch({});
    await expect(
      launchBlindPersonaTester(
        {
          custodyIndexPath: prepared.custodyIndexPath!,
          personaId: "P01",
          startupWindowWidth: 1280,
        },
        { launch: runtime.launch },
      ),
    ).rejects.toThrow(/must be provided together/u);
    await expect(
      launchBlindPersonaTester(
        {
          custodyIndexPath: prepared.custodyIndexPath!,
          personaId: "P01",
          startupZoomFactor: 9,
        },
        { launch: runtime.launch },
      ),
    ).rejects.toThrow(/between 1 and 5/u);
    expect(runtime.launches).toBe(0);
  });

  it("opens the driver CDP channel only when opted in and fails closed without a verified port", async () => {
    const root = await uniqueTestRoot("blind-driver-cdp");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01", "P02", "P03", "P04"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;

    // Flag absent: unchanged zero-network args, no debugging channel.
    const plain = driverChannelLaunch({ emitPorts: () => null });
    const plainSession = await launchBlindPersonaTester(
      { custodyIndexPath, personaId: "P01" },
      { launch: plain.launch },
    );
    expect(plain.launches[0]).toEqual([
      ".",
      "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost",
      "--proxy-server=127.0.0.1:9",
    ]);
    expect(plainSession.driverChannel).toEqual({ enabled: false });
    const plainRecord = JSON.parse(
      await readFile(plainSession.launchRecordPath, "utf8"),
    );
    expect(plainRecord.driverChannel).toEqual({ enabled: false });
    await plainSession.close();

    // Flag present: ephemeral --remote-debugging-port=0 resolved through the
    // workspace DevToolsActivePort file AND confirmed live with the required
    // endpoint keys; network blocking stays intact.
    const ephemeralPort = await freeLoopbackPort();
    const ephemeral = driverChannelLaunch({
      cdpResponse: (port) => ({
        Browser: "fake/1",
        webSocketDebuggerUrl: `wss://127.0.0.1:${port}/devtools/browser/guid`,
      }),
      emitPorts: (args) =>
        args.includes("--remote-debugging-port=0") &&
        args.includes("--remote-debugging-address=127.0.0.1")
          ? ephemeralPort
          : null,
    });
    try {
      const cdpSession = await launchBlindPersonaTester(
        { custodyIndexPath, driverCdp: true, personaId: "P02" },
        { driverTimeoutMs: 400, launch: ephemeral.launch },
      );
      expect(ephemeral.launches).toHaveLength(1);
      expect(ephemeral.launches[0]).toContain("--proxy-server=127.0.0.1:9");
      expect(ephemeral.launches[0]).toContain(
        "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost",
      );
      expect(cdpSession.driverChannel).toEqual({
        bindAddress: "127.0.0.1",
        enabled: true,
        flag: "--driver-cdp",
        networkBlockingIntact: true,
        port: ephemeralPort,
        requestedPortArg: "--remote-debugging-port=0",
        resolution: "ephemeral-port-zero-devtools-active-port-file",
        transport: "chrome-devtools-protocol",
        url: `http://127.0.0.1:${ephemeralPort}`,
      });
      const cdpRecord = JSON.parse(
        await readFile(cdpSession.launchRecordPath, "utf8"),
      );
      expect(cdpRecord.driverChannel).toEqual(cdpSession.driverChannel);
      await cdpSession.close();
    } finally {
      await ephemeral.stop();
    }

    // Unprovable ephemeral port: one verified fixed high random port
    // fallback whose file-equality proof label is preferred.
    const fixedOnly = driverChannelLaunch({
      emitPorts: (args) => {
        const requested = args
          .map((arg) => /--remote-debugging-port=(\d+)/u.exec(arg)?.[1])
          .find(Boolean);
        const port = Number(requested);
        return requested && port > 0 ? port : null;
      },
    });
    try {
      const fixedSession = await launchBlindPersonaTester(
        { custodyIndexPath, driverCdp: true, personaId: "P03" },
        { driverTimeoutMs: 200, launch: fixedOnly.launch },
      );
      expect(fixedOnly.launches).toHaveLength(2);
      const fixedRecord = JSON.parse(
        await readFile(fixedSession.launchRecordPath, "utf8"),
      );
      expect(fixedRecord.driverChannel.enabled).toBe(true);
      expect(fixedRecord.driverChannel.resolution).toBe(
        "fixed-high-random-port-devtools-active-port-file",
      );
      expect(fixedRecord.driverChannel.port).toBeGreaterThanOrEqual(49152);
      expect(fixedRecord.driverChannel.port).toBeLessThanOrEqual(65535);
      expect(fixedRecord.driverChannel.requestedPortArg).toBe(
        `--remote-debugging-port=${fixedRecord.driverChannel.port}`,
      );
      expect(fixedRecord.driverChannel.url).toBe(
        `http://127.0.0.1:${fixedRecord.driverChannel.port}`,
      );
      expect(fixedSession.driverChannel).toEqual(fixedRecord.driverChannel);
      await fixedSession.close();
    } finally {
      await fixedOnly.stop();
    }

    // Neither strategy resolves a proven port: fail closed instead of guessing.
    const silent = driverChannelLaunch({ emitPorts: () => null });
    await expect(
      launchBlindPersonaTester(
        { custodyIndexPath, driverCdp: true, personaId: "P04" },
        { driverTimeoutMs: 120, launch: silent.launch },
      ),
    ).rejects.toThrow(/failing closed/u);
    expect(silent.launches).toHaveLength(2);
    // The spawned-but-failed launch leaves exactly its immutable intent as
    // evidence (no final record), which is what lets the next attempt verify.
    const silentEntries = (
      await readdir(path.dirname(custodyIndexPath))
    ).filter((entry) => entry.startsWith("P04-"));
    expect(silentEntries).toEqual([testerLaunchIntentName("P04")]);
  });

  it("refuses a 200 /json/version body without Browser and webSocketDebuggerUrl keys", async () => {
    const root = await uniqueTestRoot("blind-driver-unkeyed");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const unkeyedPort = await freeLoopbackPort();
    const unkeyed = driverChannelLaunch({
      emitPorts: (args) =>
        args.includes("--remote-debugging-port=0") ? unkeyedPort : null,
      unkeyedPorts: [unkeyedPort],
    });
    try {
      await expect(
        launchBlindPersonaTester(
          {
            custodyIndexPath: prepared.custodyIndexPath!,
            driverCdp: true,
            personaId: "P01",
          },
          { driverTimeoutMs: 150, launch: unkeyed.launch },
        ),
      ).rejects.toThrow(/failing closed/u);
      // The keyless endpoint was probed by the ephemeral gate and rejected.
      expect(unkeyed.servers[0]?.requests ?? 0).toBeGreaterThanOrEqual(1);
      expect(unkeyed.launches).toHaveLength(2);
    } finally {
      await unkeyed.stop();
    }
  });

  const invalidCdpResponses: Array<
    [string, (port: number) => Record<string, unknown>]
  > = [
    [
      "a non-string Browser value",
      (port) => ({
        Browser: 42,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/guid`,
      }),
    ],
    [
      "a non-string webSocketDebuggerUrl value",
      () => ({ Browser: "fake/1", webSocketDebuggerUrl: 42 }),
    ],
    [
      "an empty Browser string",
      (port) => ({
        Browser: "  ",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/guid`,
      }),
    ],
    [
      "an empty webSocketDebuggerUrl string",
      () => ({ Browser: "fake/1", webSocketDebuggerUrl: "  " }),
    ],
    [
      "a foreign websocket host",
      (port) => ({
        Browser: "fake/1",
        webSocketDebuggerUrl: `ws://192.0.2.1:${port}/devtools/browser/guid`,
      }),
    ],
    [
      "a websocket port that differs from the resolved endpoint",
      (port) => ({
        Browser: "fake/1",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port === 65_535 ? 65_534 : port + 1}/devtools/browser/guid`,
      }),
    ],
  ];

  it.each(invalidCdpResponses)(
    "fails closed for %s, including fixed-port HTTP fallback without a port file",
    async (_label, responseFactory) => {
      const root = await uniqueTestRoot("blind-driver-endpoint-proof");
      const fixture = await makeAcceptedRun(root);
      const prepared = await prepareBlindPersonaWorkspaces(
        {
          acceptanceRunDir: fixture.runDir,
          expectedSealSha256: fixture.expectedSealSha256,
          custodyRoot: path.join(root, "custody"),
          destinationRoot: path.join(root, "personas"),
          personaIds: ["P01"],
        },
        { launch: runtimeLaunch({}).launch },
      );
      const invalid = driverChannelLaunch({
        cdpResponse: (port) => responseFactory(port),
        emitPorts: (args) => {
          if (args.includes("--remote-debugging-port=0")) return null;
          const requested = args
            .map((arg) => /--remote-debugging-port=(\d+)/u.exec(arg)?.[1])
            .find(Boolean);
          const port = Number(requested);
          return requested && port > 0 ? port : null;
        },
        omitDevToolsActivePortFile: () => true,
      });
      try {
        await expect(
          launchBlindPersonaTester(
            {
              custodyIndexPath: prepared.custodyIndexPath!,
              driverCdp: true,
              personaId: "P01",
            },
            { driverTimeoutMs: 200, launch: invalid.launch },
          ),
        ).rejects.toThrow(/failing closed/u);
        expect(invalid.launches).toHaveLength(2);
      } finally {
        await invalid.stop();
      }
    },
  );

  it("falls back to the fixed high port when ephemeral liveness fails", async () => {
    const root = await uniqueTestRoot("blind-driver-liveness-fallback");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const ephemeralPort = await freeLoopbackPort();
    const mixed = driverChannelLaunch({
      emitPorts: (args) => {
        if (args.includes("--remote-debugging-port=0")) return ephemeralPort;
        const requested = args
          .map((arg) => /--remote-debugging-port=(\d+)/u.exec(arg)?.[1])
          .find(Boolean);
        const port = Number(requested);
        return requested && port > 0 ? port : null;
      },
      unkeyedPorts: [ephemeralPort],
    });
    try {
      const session = await launchBlindPersonaTester(
        {
          custodyIndexPath: prepared.custodyIndexPath!,
          driverCdp: true,
          personaId: "P01",
        },
        { driverTimeoutMs: 250, launch: mixed.launch },
      );
      expect(mixed.launches).toHaveLength(2);
      const record = JSON.parse(
        await readFile(session.launchRecordPath, "utf8"),
      );
      expect(record.driverChannel.resolution).toBe(
        "fixed-high-random-port-devtools-active-port-file",
      );
      await session.close();
    } finally {
      await mixed.stop();
    }
  });

  it("suffixes per-attempt launch records and refuses invalid attempts", async () => {
    expect(testerLaunchRecordName("P01")).toBe(
      "P01-blind-persona-tester-launch-record.json",
    );
    expect(testerLaunchRecordName("P06", 3)).toBe(
      "P06-blind-persona-tester-launch-record-attempt-3.json",
    );
    for (const badAttempt of [0, -2, 2.5]) {
      expect(() => testerLaunchRecordName("P06", badAttempt)).toThrow(
        /integer >= 1/u,
      );
    }

    const root = await uniqueTestRoot("blind-tester-attempts");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    const first = await launchBlindPersonaTester(
      { custodyIndexPath, personaId: "P01" },
      { launch: runtimeLaunch({}).launch },
    );
    expect(path.basename(first.launchRecordPath)).toBe(
      "P01-blind-persona-tester-launch-record.json",
    );
    await first.close();
    const second = await launchBlindPersonaTester(
      { attempt: 2, custodyIndexPath, personaId: "P01" },
      { launch: runtimeLaunch({}).launch },
    );
    expect(path.basename(second.launchRecordPath)).toBe(
      "P01-blind-persona-tester-launch-record-attempt-2.json",
    );
    const secondRecord = JSON.parse(
      await readFile(second.launchRecordPath, "utf8"),
    );
    expect(secondRecord.attempt).toBe(2);
    // The prior attempt remains archived evidence next to the new record.
    await expect(readFile(first.launchRecordPath, "utf8")).resolves.toEqual(
      expect.any(String),
    );
    await second.close();
    for (const badAttempt of [0, -1, 1.5]) {
      await expect(
        launchBlindPersonaTester(
          { attempt: badAttempt, custodyIndexPath, personaId: "P01" },
          { launch: runtimeLaunch({}).launch },
        ),
      ).rejects.toThrow(/integer >= 1/u);
    }
  });

  it("verifies every custody entry read-only and reports ok/fail per persona", async () => {
    const root = await uniqueTestRoot("blind-verify-all");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01", "P02"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    await expect(
      verifyAllPreparedPersonaWorkspaces({ custodyIndexPath }),
    ).resolves.toEqual({
      custodyIndexPath: path.resolve(custodyIndexPath),
      failures: 0,
      ok: 2,
      results: [
        {
          error: null,
          mode: "strict",
          ok: true,
          personaId: "P01",
          runtimeVolatileFileCount: 0,
          runtimeVolatileSpecialEntryCount: 0,
        },
        {
          error: null,
          mode: "strict",
          ok: true,
          personaId: "P02",
          runtimeVolatileFileCount: 0,
          runtimeVolatileSpecialEntryCount: 0,
        },
      ],
      total: 2,
      waveComplete: true,
    });

    // Runtime-volatile extras are tolerated and counted, never hashed; a
    // modified sealed entry stays fail-closed in strict mode; archived launch
    // evidence flips a persona to consumed mode.
    const [first, second] = prepared.prepared;
    await writeFile(path.join(first!.userDataRoot, "injected.txt"), "x");
    const secondJobs = path.join(
      second!.userDataRoot,
      "persona-assets",
      "jobs.json",
    );
    await chmod(secondJobs, 0o644);
    await writeFile(secondJobs, '{"tampered":true}\n');
    await writeFile(
      path.join(
        path.dirname(custodyIndexPath),
        testerLaunchRecordName(first!.personaId),
      ),
      "{}\n",
    );
    const outcome = await verifyAllPreparedPersonaWorkspaces({
      custodyIndexPath,
    });
    expect(outcome.failures).toBe(1);
    expect(outcome.ok).toBe(1);
    const byPersona = Object.fromEntries(
      outcome.results.map((row) => [row.personaId, row]),
    );
    expect(byPersona.P01?.ok).toBe(true);
    expect(byPersona.P01?.mode).toBe("consumed");
    expect(byPersona.P01?.runtimeVolatileFileCount).toBe(1);
    expect(byPersona.P02?.ok).toBe(false);
    expect(byPersona.P02?.mode).toBeNull();
    expect(byPersona.P02?.error).toMatch(/Sealed workspace entry changed/u);
    expect(byPersona.P02?.runtimeVolatileFileCount).toBeNull();
  });

  it("runs consumed mode from archived evidence and still refuses deletion or special replacement", async () => {
    const root = await uniqueTestRoot("blind-consumed-mode");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01", "P02"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    const custodyDirectory = path.dirname(custodyIndexPath);
    const [first, second] = prepared.prepared;
    const firstJobs = path.join(
      first!.userDataRoot,
      "persona-assets",
      "jobs.json",
    );
    const secondJobs = path.join(
      second!.userDataRoot,
      "persona-assets",
      "jobs.json",
    );

    // Only P01 has archived launch evidence; P02 stays strict.
    await writeFile(
      path.join(custodyDirectory, testerLaunchRecordName("P01")),
      "{}\n",
    );
    await chmod(firstJobs, 0o644);
    await writeFile(firstJobs, '{"drifted":true}\n');
    await chmod(secondJobs, 0o644);
    await writeFile(secondJobs, '{"drifted":true}\n');

    // Consumed mode tolerates the drifted sealed bytes.
    const consumed = await verifyPreparedPersonaWorkspace(
      first!.userDataRoot,
      custodyIndexPath,
    );
    expect(consumed.mode).toBe("consumed");
    expect(consumed.decidedBy).toBe(
      path.join(custodyDirectory, testerLaunchRecordName("P01")),
    );

    // Strict mode still refuses the same drift without evidence.
    await expect(
      verifyPreparedPersonaWorkspace(second!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/Sealed workspace entry changed/u);

    // Fabricating P02's attempt-suffixed record flips it to consumed too.
    await writeFile(
      path.join(custodyDirectory, testerLaunchRecordName("P02", 3)),
      "{}\n",
    );
    await expect(
      verifyPreparedPersonaWorkspace(second!.userDataRoot, custodyIndexPath),
    ).resolves.toMatchObject({ mode: "consumed" });

    // Deletion fails closed even in consumed mode.
    await rm(secondJobs);
    await expect(
      verifyPreparedPersonaWorkspace(second!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/missing or shadowed/u);

    // Symlink replacement fails closed even in consumed mode.
    await chmod(firstJobs, 0o644);
    await rm(firstJobs);
    await symlink("decoy-target.json", firstJobs);
    await writeFile(
      path.join(first!.userDataRoot, "persona-assets", "decoy-target.json"),
      "[]\n",
    );
    await expect(
      verifyPreparedPersonaWorkspace(first!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/not a regular file/u);
  });

  it("uses consumed mode for attempt-2 launcher flows and refuses attempts without evidence", async () => {
    const root = await uniqueTestRoot("blind-attempt-evidence");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;

    // An attempt >= 2 claim with no archived record is refused fail-closed.
    await expect(
      launchBlindPersonaTester(
        { attempt: 2, custodyIndexPath, personaId: "P01" },
        { launch: runtimeLaunch({}).launch },
      ),
    ).rejects.toThrow(/claims a prior launch/u);

    // With archived evidence plus consumed-session byte drift, the attempt-2
    // pre-launch verification runs consumed and the relaunch succeeds.
    await writeFile(
      path.join(path.dirname(custodyIndexPath), testerLaunchRecordName("P01")),
      "{}\n",
    );
    const jobsPath = path.join(
      prepared.prepared[0]!.userDataRoot,
      "persona-assets",
      "jobs.json",
    );
    await chmod(jobsPath, 0o644);
    await writeFile(jobsPath, '{"drifted":true}\n');
    const session = await launchBlindPersonaTester(
      { attempt: 2, custodyIndexPath, personaId: "P01" },
      { launch: runtimeLaunch({}).launch },
    );
    expect(path.basename(session.launchRecordPath)).toBe(
      "P01-blind-persona-tester-launch-record-attempt-2.json",
    );
    await session.close();
  });

  it("keeps polling on fixed-port proof mismatch until failing closed at the deadline", async () => {
    const root = await uniqueTestRoot("blind-driver-file-conflict");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const conflicted = driverChannelLaunch({
      emitPorts: (args) => {
        const requested = args
          .map((arg) => /--remote-debugging-port=(\d+)/u.exec(arg)?.[1])
          .find(Boolean);
        const port = Number(requested);
        return requested && port > 0 ? port : null;
      },
      // The endpoint is live with required keys but the file names a
      // different port: this can never succeed.
      filePortOverride: (emittedPort) =>
        emittedPort === 65_535 ? 65_534 : emittedPort + 1,
    });
    try {
      await expect(
        launchBlindPersonaTester(
          {
            custodyIndexPath: prepared.custodyIndexPath!,
            driverCdp: true,
            personaId: "P01",
          },
          { driverTimeoutMs: 200, launch: conflicted.launch },
        ),
      ).rejects.toThrow(/failing closed/u);
      expect(conflicted.launches).toHaveLength(2);
      // Multiple probes prove continued polling instead of an instant null.
      expect(conflicted.servers[0]?.requests ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      await conflicted.stop();
    }
  });

  it("fails closed when the fixed-port proof file is malformed", async () => {
    const root = await uniqueTestRoot("blind-driver-malformed-port-file");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const malformed = driverChannelLaunch({
      emitPorts: (args) => {
        const requested = args
          .map((arg) => /--remote-debugging-port=(\d+)/u.exec(arg)?.[1])
          .find(Boolean);
        const port = Number(requested);
        return requested && port > 0 ? port : null;
      },
      filePortOverride: () => 65_536,
    });
    try {
      await expect(
        launchBlindPersonaTester(
          {
            custodyIndexPath: prepared.custodyIndexPath!,
            driverCdp: true,
            personaId: "P01",
          },
          { driverTimeoutMs: 200, launch: malformed.launch },
        ),
      ).rejects.toThrow(/failing closed/u);
      expect(malformed.launches).toHaveLength(2);
      expect(malformed.servers[0]?.requests ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      await malformed.stop();
    }
  });

  it("rethrows non-EEXIST partial-wave custody failures with original-cause parity", async () => {
    const root = await uniqueTestRoot("blind-custody-non-eexist");
    const fixture = await makeAcceptedRun(root);
    const common = {
      acceptanceRunDir: fixture.runDir,
      custodyRoot: path.join(root, "custody"),
      destinationRoot: path.join(root, "personas"),
      expectedSealSha256: fixture.expectedSealSha256,
    };
    await expect(
      prepareBlindPersonaWorkspaces(
        { ...common, personaIds: ["P01", "P02"] },
        {
          launch: runtimeLaunch({ mutateRestart: true, mutateRestartAt: 4 })
            .launch,
        },
      ),
    ).rejects.toThrow(/incomplete-wave custody/u);

    const custodyDirectory = common.custodyRoot;
    // EEXIST preempts permission checks on an existing index, so force a
    // non-EEXIST custody failure by swapping the custody root for a symlink
    // mid-wave (after P03 seals, before P04's failing restart completes).
    const inner = runtimeLaunch({ mutateRestart: true, mutateRestartAt: 4 });
    let launchCount = 0;
    const sabotaging: LaunchSeedElectron = async (input) => {
      const app = await inner.launch(input);
      launchCount += 1;
      if (launchCount === 4) {
        const aliasTarget = path.join(root, "custody-alias-target");
        await rm(custodyDirectory, { recursive: true, force: true });
        await mkdir(aliasTarget, { recursive: true });
        await symlink(aliasTarget, custodyDirectory);
      }
      return app;
    };
    try {
      await expect(
        prepareBlindPersonaWorkspaces(
          { ...common, personaIds: ["P03", "P04"] },
          { launch: sabotaging },
        ),
      ).rejects.toThrow(
        /quarantined or removed[\s\S]*incomplete-wave custody write failed/u,
      );
    } finally {
      const stats = await lstat(custodyDirectory).catch(() => null);
      if (stats?.isSymbolicLink()) {
        await unlink(custodyDirectory);
      }
    }
  });

  it("fails closed when a sealed entry is missing or replaced by a symlink", async () => {
    const root = await uniqueTestRoot("blind-sealed-entry-violations");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01", "P02"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    const [first, second] = prepared.prepared;

    // Seeded bytes replaced by a symlink: never followed, always fail-closed.
    const firstJobs = path.join(
      first!.userDataRoot,
      "persona-assets",
      "jobs.json",
    );
    await chmod(firstJobs, 0o644);
    await rm(firstJobs);
    await symlink("decoy-target.json", firstJobs);
    await writeFile(
      path.join(first!.userDataRoot, "persona-assets", "decoy-target.json"),
      "[]\n",
    );
    await expect(
      verifyPreparedPersonaWorkspace(first!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/not a regular file/u);

    // Seeded entry deleted outright must also fail closed.
    const secondJobs = path.join(
      second!.userDataRoot,
      "persona-assets",
      "jobs.json",
    );
    await chmod(secondJobs, 0o644);
    await rm(secondJobs);
    await expect(
      verifyPreparedPersonaWorkspace(second!.userDataRoot, custodyIndexPath),
    ).rejects.toThrow(/missing or shadowed/u);
  });

  it("tolerates runtime-volatile leftovers across relaunches and re-verification", async () => {
    const root = await uniqueTestRoot("blind-runtime-volatile");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyIndexPath = prepared.custodyIndexPath!;
    const userDataRoot = prepared.prepared[0]!.userDataRoot;

    // Before any launch record exists, verification is strict.
    await expect(
      verifyPreparedPersonaWorkspace(userDataRoot, custodyIndexPath),
    ).resolves.toMatchObject({ decidedBy: null, mode: "strict" });

    const ephemeralPort = await freeLoopbackPort();
    const cdp = driverChannelLaunch({
      emitPorts: (args) =>
        args.includes("--remote-debugging-port=0") ? ephemeralPort : null,
    });
    try {
      const session = await launchBlindPersonaTester(
        { custodyIndexPath, driverCdp: true, personaId: "P01" },
        { driverTimeoutMs: 400, launch: cdp.launch },
      );
      await session.close();
    } finally {
      await cdp.stop();
    }
    // A simulated window-open artifact from an interrupted session.
    await writeFile(path.join(userDataRoot, "window-open-state.json"), "{}");
    // A non-sealed symlink among the extras is recorded, not followed.
    await symlink("window-open-state.json", path.join(userDataRoot, "link"));

    // The archived launch record flips re-verification to consumed mode.
    const verification = await verifyPreparedPersonaWorkspace(
      userDataRoot,
      custodyIndexPath,
    );
    expect(verification.mode).toBe("consumed");
    expect(verification.decidedBy).toBe(
      path.join(
        path.dirname(custodyIndexPath),
        "P01-blind-persona-tester-launch-record.json",
      ),
    );
    expect(verification.runtimeVolatileFiles).toEqual([
      "DevToolsActivePort",
      "window-open-state.json",
    ]);
    expect(verification.runtimeVolatileFileCount).toBe(2);
    expect(verification.runtimeVolatileSpecialEntries).toEqual([
      { kind: "symlink", path: "link" },
    ]);
    expect(verification.sealedEntryCount).toBeGreaterThan(0);

    // Attempt-2 relaunch after the leftovers succeeds and archives evidence;
    // pre-launch verification ran in consumed mode automatically.
    const second = await launchBlindPersonaTester(
      { attempt: 2, custodyIndexPath, personaId: "P01" },
      { launch: runtimeLaunch({}).launch },
    );
    expect(path.basename(second.launchRecordPath)).toBe(
      "P01-blind-persona-tester-launch-record-attempt-2.json",
    );
    await second.close();

    // The earliest archived record remains the deciding evidence.
    const afterSecond = await verifyPreparedPersonaWorkspace(
      userDataRoot,
      custodyIndexPath,
    );
    expect(afterSecond.mode).toBe("consumed");
    expect(path.basename(afterSecond.decidedBy ?? "")).toBe(
      "P01-blind-persona-tester-launch-record.json",
    );
  });

  it("aggregates the original cause when a retry hits an existing custody index", async () => {
    const root = await uniqueTestRoot("blind-custody-eexist");
    const fixture = await makeAcceptedRun(root);
    const common = {
      acceptanceRunDir: fixture.runDir,
      custodyRoot: path.join(root, "custody"),
      destinationRoot: path.join(root, "personas"),
      expectedSealSha256: fixture.expectedSealSha256,
    };
    await expect(
      prepareBlindPersonaWorkspaces(
        { ...common, personaIds: ["P01", "P02"] },
        {
          launch: runtimeLaunch({ mutateRestart: true, mutateRestartAt: 4 })
            .launch,
        },
      ),
    ).rejects.toThrow(/incomplete-wave custody/u);

    // Retry into the SAME custody root while a later persona fails again:
    // the EEXIST must not mask the original quarantine failure.
    await expect(
      prepareBlindPersonaWorkspaces(
        { ...common, personaIds: ["P03", "P04"] },
        {
          launch: runtimeLaunch({ mutateRestart: true, mutateRestartAt: 4 })
            .launch,
        },
      ),
    ).rejects.toThrow(/quarantined or removed[\s\S]*fresh --custody-root/u);

    // Full-wave retry into the same root fails on the final seal write only.
    await expect(
      prepareBlindPersonaWorkspaces(
        { ...common, personaIds: ["P05"] },
        { launch: runtimeLaunch({}).launch },
      ),
    ).rejects.toThrow(/fresh --custody-root per preparation invocation/u);
  });

  it("canonicalizes the destination root before building persona roots", async () => {
    const root = await uniqueTestRoot("blind-canonical-destination");
    const fixture = await makeAcceptedRun(root);
    const dottedDestination = `${path.join(root, "personas")}${path.sep}.`;
    const result = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: dottedDestination,
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const canonicalPersonas = await realpath(path.join(root, "personas"));
    const userDataRoot = result.prepared[0]!.userDataRoot;
    expect(userDataRoot.startsWith(`${canonicalPersonas}${path.sep}P01-`)).toBe(
      true,
    );
    const custody = JSON.parse(
      await readFile(result.custodyIndexPath!, "utf8"),
    ) as { personas: { userDataRoot: string }[] };
    expect(custody.personas[0]?.userDataRoot).toBe(userDataRoot);
  });

  it("fails verify-all closed on custody digest mismatch or an empty wave", async () => {
    const root = await uniqueTestRoot("blind-verify-all-custody");
    const fixture = await makeAcceptedRun(root);
    const prepared = await prepareBlindPersonaWorkspaces(
      {
        acceptanceRunDir: fixture.runDir,
        expectedSealSha256: fixture.expectedSealSha256,
        custodyRoot: path.join(root, "custody"),
        destinationRoot: path.join(root, "personas"),
        personaIds: ["P01"],
      },
      { launch: runtimeLaunch({}).launch },
    );
    const custodyPath = prepared.custodyIndexPath!;
    const custody = JSON.parse(await readFile(custodyPath, "utf8")) as Record<
      string,
      unknown
    >;
    custody.waveComplete = false;
    await chmod(custodyPath, 0o644);
    await writeFile(custodyPath, `${JSON.stringify(custody, null, 2)}\n`);
    await expect(
      verifyAllPreparedPersonaWorkspaces({ custodyIndexPath: custodyPath }),
    ).rejects.toThrow(/digest mismatch/u);

    const emptySubject = {
      schemaVersion: 1,
      threatBoundary: "test boundary",
      waveComplete: true,
      build: { runDir: "/nowhere" },
      personas: [],
    };
    const emptyPath = path.join(root, "empty-custody.json");
    await writeFile(
      emptyPath,
      `${JSON.stringify(
        {
          ...emptySubject,
          custodyIndexSha256: sha256(stableSeedSerialization(emptySubject)),
        },
        null,
        2,
      )}\n`,
    );
    await expect(
      verifyAllPreparedPersonaWorkspaces({ custodyIndexPath: emptyPath }),
    ).rejects.toThrow(/no prepared personas/u);
  });

  it("parses tester driver/attempt authority and advertises boundaries", () => {
    expect(
      parseBlindPersonaTesterCli([
        "--custody-index",
        "c.json",
        "--persona",
        "P06",
        "--attempt",
        "4",
        "--driver-cdp",
      ]),
    ).toEqual({
      attempt: 4,
      custodyIndexPath: path.resolve("c.json"),
      driverCdp: true,
      personaId: "P06",
    });
    expect(
      parseBlindPersonaTesterCli([
        "--custody-index",
        "c.json",
        "--persona",
        "P01",
      ]),
    ).toEqual({
      custodyIndexPath: path.resolve("c.json"),
      personaId: "P01",
    });
    for (const badAttempt of ["second", "-3", "2.5", "+4", "4e1", " 4", "4 "]) {
      expect(() =>
        parseBlindPersonaTesterCli([
          "--custody-index",
          "c.json",
          "--persona",
          "P01",
          "--attempt",
          badAttempt,
        ]),
      ).toThrow(/canonical positive integer/u);
    }
    for (const outOfRangeAttempt of ["0", "999999999999999999999"]) {
      expect(() =>
        parseBlindPersonaTesterCli([
          "--custody-index",
          "c.json",
          "--persona",
          "P01",
          "--attempt",
          outOfRangeAttempt,
        ]),
      ).toThrow(/integer >= 1/u);
    }
    // Leading zeros stay tolerated, consistent with the startup dimension
    // syntax shared with the desktop shell parser.
    expect(
      parseBlindPersonaTesterCli([
        "--custody-index",
        "c.json",
        "--persona",
        "P01",
        "--attempt",
        "007",
      ])?.attempt,
    ).toBe(7);
    expect(
      parseBlindPersonaVerifyAllCli([
        "--verify-all",
        "--custody-index",
        "i.json",
      ]),
    ).toEqual({ custodyIndexPath: path.resolve("i.json") });
    expect(parseBlindPersonaVerifyAllCli(["--help"])).toBeNull();
    expect(BLIND_PERSONA_TESTER_HELP).toContain("--driver-cdp");
    expect(BLIND_PERSONA_TESTER_HELP).toContain("--attempt <n>");
    expect(BLIND_PERSONA_TESTER_HELP).toContain(
      "parent-side automation channel",
    );
    expect(BLIND_PERSONA_TESTER_HELP).toContain("grants no tester authority");
    expect(BLIND_PERSONA_TESTER_HELP).toContain("--proxy-server=127.0.0.1:9");
    expect(BLIND_PERSONA_TESTER_HELP).toContain("runtime-volatile");
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain("--verify-all");
    expect(BLIND_PERSONA_SEED_HELP).toContain("--verify-all");
  });

  it("parses tester startup geometry authority and pins the native zoom channel", () => {
    const base = ["--custody-index", "c.json", "--persona", "P12"];
    expect(
      parseBlindPersonaTesterCli([
        ...base,
        "--window-width",
        "1280",
        "--window-height",
        "800",
        "--zoom-factor",
        "2.5",
      ]),
    ).toEqual({
      custodyIndexPath: path.resolve("c.json"),
      personaId: "P12",
      startupWindowHeight: 800,
      startupWindowWidth: 1280,
      startupZoomFactor: 2.5,
    });
    const plain = parseBlindPersonaTesterCli(base);
    expect(plain).not.toHaveProperty("startupWindowWidth");
    expect(plain).not.toHaveProperty("startupWindowHeight");
    expect(plain).not.toHaveProperty("startupZoomFactor");

    expect(() =>
      parseBlindPersonaTesterCli([...base, "--window-width", "1280"]),
    ).toThrow(/must be provided together/u);
    expect(() =>
      parseBlindPersonaTesterCli([...base, "--window-height", "800"]),
    ).toThrow(/must be provided together/u);
    for (const badDimension of ["0", "399", "8193", "999999999999999999999"]) {
      expect(() =>
        parseBlindPersonaTesterCli([
          ...base,
          "--window-width",
          badDimension,
          "--window-height",
          "800",
        ]),
      ).toThrow(/integer between 400 and 8192/u);
    }
    for (const nonCanonicalDimension of [
      "abc",
      "-800",
      "12.5",
      "+1280",
      " 1280",
      "1280px",
      "8e2",
    ]) {
      expect(() =>
        parseBlindPersonaTesterCli([
          ...base,
          "--window-width",
          nonCanonicalDimension,
          "--window-height",
          "800",
        ]),
      ).toThrow(/canonical positive integer/u);
    }
    for (const badZoom of ["0", "0.5", "5.01"]) {
      expect(() =>
        parseBlindPersonaTesterCli([...base, "--zoom-factor", badZoom]),
      ).toThrow(/between 1 and 5/u);
    }
    for (const nonCanonicalZoom of ["-2", "two", "+2.5", "2e0", " 2"]) {
      expect(() =>
        parseBlindPersonaTesterCli([
          ...base,
          "--zoom-factor",
          nonCanonicalZoom,
        ]),
      ).toThrow(/canonical decimal/u);
    }
    // P12 boundary pinning: a device-scale override is not an accepted
    // native-zoom channel and stays rejected as an unknown argument.
    expect(() =>
      parseBlindPersonaTesterCli([...base, "--force-device-scale-factor", "2"]),
    ).toThrow(/Unknown blind-persona CLI argument/u);
    expect(BLIND_PERSONA_TESTER_HELP).toContain("--window-width");
    expect(BLIND_PERSONA_TESTER_HELP).toContain("--window-height");
    expect(BLIND_PERSONA_TESTER_HELP).toContain("--zoom-factor");
    expect(BLIND_PERSONA_TESTER_HELP).toContain("setZoomFactor");
    expect(BLIND_PERSONA_TESTER_HELP).not.toContain(
      "--force-device-scale-factor override is accepted",
    );
  });

  it("rejects unknown flags and stray positionals across all parsers", () => {
    const seedBase = [
      "--acceptance-run-dir",
      "run",
      "--expected-seal-sha256",
      "a".repeat(64),
      "--destination-root",
      "personas",
      "--custody-root",
      "custody",
    ];
    expect(() =>
      parseBlindPersonaSeedCli([...seedBase, "--telemetry", "on"]),
    ).toThrow(/Unknown blind-persona CLI argument: --telemetry/u);
    expect(() => parseBlindPersonaSeedCli([...seedBase, "stray.json"])).toThrow(
      /Unexpected blind-persona CLI positional: stray\.json/u,
    );
    expect(() =>
      parseBlindPersonaTesterCli([
        "--custody-index",
        "c.json",
        "--persona",
        "P01",
        "--record-video",
      ]),
    ).toThrow(/Unknown blind-persona CLI argument: --record-video/u);
    expect(() =>
      parseBlindPersonaVerifyAllCli([
        "--verify-all",
        "--custody-index",
        "i.json",
        "--deep",
      ]),
    ).toThrow(/Unknown blind-persona CLI argument: --deep/u);
  });

  it("rejects duplicate valued flags across all parsers", () => {
    expect(() =>
      parseBlindPersonaSeedCli([
        "--acceptance-run-dir",
        "run",
        "--expected-seal-sha256",
        "a".repeat(64),
        "--destination-root",
        "personas",
        "--custody-root",
        "custody-a",
        "--custody-root",
        "custody-b",
      ]),
    ).toThrow(/Duplicate blind-persona CLI argument: --custody-root/u);
    expect(() =>
      parseBlindPersonaTesterCli([
        "--custody-index",
        "c.json",
        "--persona",
        "P01",
        "--persona",
        "P02",
      ]),
    ).toThrow(/Duplicate blind-persona CLI argument: --persona/u);
    expect(() =>
      parseBlindPersonaVerifyAllCli([
        "--verify-all",
        "--custody-index",
        "i.json",
        "--custody-index",
        "other.json",
      ]),
    ).toThrow(/Duplicate blind-persona CLI argument: --custody-index/u);
  });

  it("rejects duplicate boolean flags across all parsers", () => {
    expect(() =>
      parseBlindPersonaTesterCli([
        "--custody-index",
        "c.json",
        "--persona",
        "P01",
        "--driver-cdp",
        "--driver-cdp",
      ]),
    ).toThrow(/Duplicate blind-persona CLI argument: --driver-cdp/u);
    expect(() =>
      parseBlindPersonaSeedCli([
        "--acceptance-run-dir",
        "run",
        "--expected-seal-sha256",
        "a".repeat(64),
        "--destination-root",
        "personas",
        "--custody-root",
        "custody",
        "--dry-run",
        "--dry-run",
      ]),
    ).toThrow(/Duplicate blind-persona CLI argument: --dry-run/u);
    expect(() =>
      parseBlindPersonaVerifyAllCli([
        "--verify-all",
        "--verify-all",
        "--custody-index",
        "i.json",
      ]),
    ).toThrow(/Duplicate blind-persona CLI argument: --verify-all/u);
  });

  it("documents fresh custody roots, empty-index refusal, and wave caveats", () => {
    expect(BLIND_PERSONA_SEED_HELP).toContain(
      "fresh --custody-root per preparation invocation",
    );
    expect(BLIND_PERSONA_SEED_HELP).toContain("original cause");
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toMatch(/empty\s+custody\s+index/iu);
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain("waveComplete:false");
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain("runtime-volatile");
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain("DevToolsActivePort");
    expect(BLIND_PERSONA_TESTER_HELP).toMatch(
      /strict\s+before\s+any\s+archived\s+launch\s+record/iu,
    );
    expect(BLIND_PERSONA_TESTER_HELP).toMatch(/consumed afterward/iu);
    expect(BLIND_PERSONA_TESTER_HELP).toContain(
      "reseeding is not required for relaunch",
    );
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain("verification is STRICT");
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain("runs CONSUMED");
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain(
      "reseeding is not required",
    );
    expect(BLIND_PERSONA_VERIFY_ALL_HELP).toContain("byte drift");
  });

  it("parses only the accepted run directory/custody CLI authority", () => {
    expect(BLIND_PERSONA_SEED_HELP).toContain("--acceptance-run-dir");
    expect(BLIND_PERSONA_SEED_HELP).not.toContain("--build-manifest-sha256");
    expect(parseBlindPersonaSeedCli(["--help"])).toBeNull();
    expect(
      parseBlindPersonaSeedCli([
        "--acceptance-run-dir",
        "run",
        "--expected-seal-sha256",
        "a".repeat(64),
        "--destination-root",
        "personas",
        "--custody-root",
        "custody",
        "--persona",
        "P14",
        "--dry-run",
      ]),
    ).toMatchObject({ personaIds: ["P14"], dryRun: true });
  });
});
