// Dev-only: keeps @vitejs/plugin-react's Babel output on disk between dev
// starts. In dev that plugin runs Babel over every .tsx module only to add
// React Fast Refresh registrations, which was about a third of the time
// the dev server spent compiling the opening screen. The output depends
// only on the module id, its source and the plugin setup (folded into
// `namespace`), so an unchanged module reuses its last result.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, PluginOption } from "vite";

const cacheVersion = 1;
const unusedEntryLifetimeMs = 14 * 24 * 60 * 60 * 1000;

interface CachedTransform {
  code: string;
  map: unknown;
  usedAt: number;
}

interface CacheFile {
  version: number;
  namespace: string;
  entries: Record<string, CachedTransform>;
}

type TransformHook = NonNullable<Plugin["transform"]>;
type TransformHandler = Extract<TransformHook, (...args: never[]) => unknown>;

function isPlugin(option: PluginOption): option is Plugin {
  return typeof option === "object" && option !== null && "name" in option;
}

function readEntries(
  cacheFile: string,
  namespace: string,
): Record<string, CachedTransform> {
  try {
    const file = JSON.parse(readFileSync(cacheFile, "utf8")) as CacheFile;
    if (file.version === cacheVersion && file.namespace === namespace) {
      return file.entries;
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return {};
}

export function withReactRefreshCache(
  plugins: PluginOption[],
  options: { cacheFile: string; namespace: string },
): PluginOption[] {
  const babelPlugin = plugins
    .flat()
    .find(
      (option): option is Plugin =>
        isPlugin(option) && option.name === "vite:react-babel",
    );
  const hook = babelPlugin?.transform;
  if (!babelPlugin || !hook) {
    return plugins;
  }
  const handler: TransformHandler =
    typeof hook === "function" ? hook : hook.handler;

  let entries: Record<string, CachedTransform> | null = null;
  let saveTimer: NodeJS.Timeout | null = null;

  const save = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!entries) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of Object.entries(entries)) {
      if (now - entry.usedAt > unusedEntryLifetimeMs) {
        delete entries[key];
      }
    }
    const file: CacheFile = {
      version: cacheVersion,
      namespace: options.namespace,
      entries,
    };
    try {
      mkdirSync(path.dirname(options.cacheFile), { recursive: true });
      const tempFile = `${options.cacheFile}.${process.pid}.tmp`;
      writeFileSync(tempFile, JSON.stringify(file));
      renameSync(tempFile, options.cacheFile);
    } catch {
      // A cache that cannot be written only costs the next start time.
    }
  };
  const scheduleSave = () => {
    if (!saveTimer) {
      saveTimer = setTimeout(save, 1000);
      saveTimer.unref();
    }
  };
  process.once("exit", () => {
    if (saveTimer) {
      save();
    }
  });

  const cachedHandler = async function (
    this: ThisParameterType<TransformHandler>,
    ...args: Parameters<TransformHandler>
  ): Promise<Awaited<ReturnType<TransformHandler>>> {
    const [code, id] = args;
    entries ??= readEntries(options.cacheFile, options.namespace);
    const key = createHash("sha1").update(`${id}\0${code}`).digest("hex");
    const hit = entries[key];
    if (hit) {
      hit.usedAt = Date.now();
      return { code: hit.code, map: hit.map as never };
    }
    const result = await handler.apply(this, args);
    if (
      result &&
      typeof result === "object" &&
      typeof result.code === "string"
    ) {
      entries[key] = { code: result.code, map: result.map, usedAt: Date.now() };
      scheduleSave();
    }
    return result;
  };

  babelPlugin.transform =
    typeof hook === "function"
      ? cachedHandler
      : { ...hook, handler: cachedHandler };
  return plugins;
}
