import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const provenanceName = "nestor-profile-provenance.json";
export function profileProvenance(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, provenanceName), "utf8"));
  } catch {
    return { kind: "unknown", method: "no provenance record" };
  }
}
function canonical(dir) {
  if (existsSync(dir)) return realpathSync(dir);
  return path.join(canonical(path.dirname(dir)), path.basename(dir));
}
export function inside(candidate, parent) {
  const relative = path.relative(canonical(parent), canonical(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export function prepareLiveProfile(dir, forbiddenRoots) {
  dir = path.resolve(dir);
  if (
    forbiddenRoots.some(
      (root) => root && (inside(dir, root) || inside(root, dir)),
    )
  )
    throw new Error(
      "--live-profile must be outside the repository, campaign/trace folder and app data root, and cannot contain those folders.",
    );
  const existed = existsSync(dir);
  if (!existed) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, provenanceName);
  if (!existsSync(marker)) {
    const empty = readdirSync(dir).length === 0;
    writeFileSync(
      marker,
      JSON.stringify(
        {
          version: 1,
          kind: empty ? "app_setup" : "unknown",
          method: empty
            ? "Created empty by isolated-app --live-profile; populated through the app's own setup"
            : "Adopted existing folder; creation not observed",
          createdAt: new Date().toISOString(),
          persistent: true,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
  }
  return dir;
}
export function assertLiveProfile(dir, net) {
  if (net === "live" && profileProvenance(dir).kind === "synthetic")
    throw new Error(
      "Live network refused: this profile was seeded through a synthetic/test API. Use an empty --live-profile and the app's own setup.",
    );
}
