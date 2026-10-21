// Dev-only: lets `pnpm desktop:dev` reuse the main and preload bundles from
// the last dev start when nothing they are built from has changed. Building
// the main bundle is most of the wait before the window opens.
//
// A dev build records every module it bundled (size, mtime and content hash)
// and every file it wrote. The next dev start reuses the output only when
// the key (config, helpers, tsconfigs, package manifests, lockfile, build
// flags) matches, every recorded input is unchanged and every output
// is still the file this build wrote, so a production build or a failed
// build in between forces a rebuild.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const manifestVersion = 1;

type InputStamp = [size: number, mtimeMs: number, sha1: string];
type OutputStamp = [size: number, mtimeMs: number];

interface DevBuildManifest {
  version: number;
  key: string;
  inputs: Record<string, InputStamp>;
  outputs: Record<string, OutputStamp>;
}

export interface DevBuildCache {
  /** The previous dev build's output is current and can be used as is. */
  readonly reusable: boolean;
  /** Records this build's inputs and outputs for the next dev start. */
  readonly plugin: Plugin;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function listFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));
}

/**
 * Files that change how any module is built without being a module itself.
 */
export function listBuildKeyFiles(desktopDir: string): string[] {
  const repoRoot = path.resolve(desktopDir, "../..");
  const packagesDir = path.join(repoRoot, "packages");
  const packageDirs = existsSync(packagesDir)
    ? readdirSync(packagesDir).map((name) => path.join(packagesDir, name))
    : [];
  const configFiles = /^(tsconfig.*\.json|package\.json)$/;
  return [
    path.join(repoRoot, "pnpm-lock.yaml"),
    ...listFiles(repoRoot, configFiles),
    ...listFiles(desktopDir, configFiles),
    ...listFiles(desktopDir, /^\.env/),
    ...packageDirs.flatMap((dir) => listFiles(dir, configFiles)),
  ];
}

export function hashFiles(files: string[], extra: string): string {
  const hash = createHash("sha256").update(extra);
  for (const file of files) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update("missing");
    }
  }
  return hash.digest("hex");
}

// Build flags electron-vite takes from its command line that change the
// main and preload output.
export function readDevBuildFlags(mode: string): {
  watch: boolean;
  key: string;
} {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const index = args.findIndex(
      (arg) => arg === flag || arg.startsWith(`${flag}=`),
    );
    const arg = args[index];
    if (index === -1 || arg === undefined) {
      return null;
    }
    return arg.includes("=")
      ? arg.slice(flag.length + 1)
      : (args[index + 1] ?? null);
  };
  return {
    watch: args.includes("-w") || args.includes("--watch"),
    key: JSON.stringify({
      mode,
      sourcemap: args.includes("--sourcemap"),
      outDir: valueOf("--outDir"),
    }),
  };
}

function readManifest(file: string): DevBuildManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as DevBuildManifest;
    return manifest.version === manifestVersion ? manifest : null;
  } catch {
    return null;
  }
}

function inputUnchanged(
  file: string,
  [size, mtimeMs, hash]: InputStamp,
): boolean {
  try {
    const stat = statSync(file);
    if (stat.size === size && stat.mtimeMs === mtimeMs) {
      return true;
    }
    // Touched (checkout, formatter) but possibly the same content.
    return sha1(readFileSync(file, "utf8")) === hash;
  } catch {
    return false;
  }
}

function outputUnchanged(file: string, [size, mtimeMs]: OutputStamp): boolean {
  try {
    const stat = statSync(file);
    return stat.size === size && stat.mtimeMs === mtimeMs;
  } catch {
    return false;
  }
}

function isReusable(manifest: DevBuildManifest | null, key: string): boolean {
  if (!manifest || manifest.key !== key) {
    return false;
  }
  const outputs = Object.entries(manifest.outputs);
  return (
    outputs.length > 0 &&
    outputs.every(([file, stamp]) => outputUnchanged(file, stamp)) &&
    Object.entries(manifest.inputs).every(([file, stamp]) =>
      inputUnchanged(file, stamp),
    )
  );
}

export function devBuildCache(options: {
  /** Bundle name, e.g. "main". */
  name: string;
  /** Folder for the manifest. */
  cacheDir: string;
  /**
   * Hash of everything besides the bundled modules that the output depends
   * on: config, helpers, the files from `listBuildKeyFiles`, build flags.
   */
  key: string;
}): DevBuildCache {
  const manifestFile = path.join(options.cacheDir, `${options.name}.json`);
  const { key } = options;
  const reusable = isReusable(readManifest(manifestFile), key);

  // The content each module had when it was loaded, before any transform.
  const loadedHashes = new Map<string, string>();
  let buildStartedAt = 0;

  const plugin: Plugin = {
    name: "nestor:dev-build-cache",
    enforce: "pre",
    buildStart() {
      buildStartedAt = Date.now();
      loadedHashes.clear();
      // A build that fails part way must not leave a manifest behind.
      rmSync(manifestFile, { force: true });
    },
    transform(code, id) {
      if (!id.startsWith("\0") && !loadedHashes.has(id)) {
        loadedHashes.set(id, sha1(code));
      }
      return null;
    },
    writeBundle(outputOptions, bundle) {
      const inputs: Record<string, InputStamp> = {};
      for (const id of this.getModuleIds()) {
        if (id.startsWith("\0")) {
          continue;
        }
        const file = id.split("?")[0] ?? id;
        let stat;
        try {
          stat = statSync(file);
        } catch {
          continue;
        }
        if (!stat.isFile()) {
          continue;
        }
        const hash = loadedHashes.get(id) ?? sha1(readFileSync(file, "utf8"));
        // A file edited while this build ran may differ from what was
        // bundled; leave its stamp unmatched so the next start re-checks
        // its content against the hash taken at load time.
        inputs[file] =
          stat.mtimeMs >= buildStartedAt - 1000
            ? [-1, -1, hash]
            : [stat.size, stat.mtimeMs, hash];
      }
      const outDir =
        outputOptions.dir ?? path.dirname(outputOptions.file ?? "");
      const outputs: Record<string, OutputStamp> = {};
      for (const fileName of Object.keys(bundle)) {
        const file = path.resolve(outDir, fileName);
        const stat = statSync(file);
        outputs[file] = [stat.size, stat.mtimeMs];
      }
      const manifest: DevBuildManifest = {
        version: manifestVersion,
        key,
        inputs,
        outputs,
      };
      mkdirSync(options.cacheDir, { recursive: true });
      const tempFile = `${manifestFile}.${process.pid}.tmp`;
      writeFileSync(tempFile, JSON.stringify(manifest));
      renameSync(tempFile, manifestFile);
    },
  };

  return { reusable, plugin };
}

/**
 * Dev-only build settings for the main and preload bundles. Vite re-runs
 * esbuild over each finished chunk to lower its syntax to the Node target;
 * the dev bundle runs only on this Electron, which already supports it, and
 * the pass costs about 2.5 s on the 6 MB main chunk.
 */
export const skipTargetTranspilePlugin: Plugin = {
  name: "nestor:dev-skip-target-transpile",
  enforce: "post",
  renderChunk(_code, _chunk, outputOptions) {
    (
      outputOptions as { __vite_skip_esbuild__?: boolean }
    ).__vite_skip_esbuild__ = true;
    return null;
  },
};
