/** Reuse the scale manifest's loopback aliases; no DNS or hosts-file changes.
 * A board's listing and application stay on the same origin for session cookies.
 */
const HOSTS: Readonly<Record<string, number>> = {
  board: 2,
  "employer-a": 2,
  greenhouse: 3,
  lever: 4,
  workday: 5,
  // Shares Workday's alias: a different employer path on the same host.
  "workday-prompts": 5,
  gatekeeper: 6,
  atlas: 7,
  ripple: 8,
  pacer: 9,
  slowgrove: 10,
  framehire: 11,
  authboard: 12,
};

/**
 * macOS binds only 127.0.0.1 unless lo0 has aliases. There every replica
 * stays on the fixture server's own host: one origin for all employers, so
 * they prepare one after another, and nothing else changes.
 */
let aliasesBound = true;

export function replicaUrl(base: string, pathname: string): string {
  const url = new URL(pathname, base);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw Error("Scoreboard replicas require the local fixture server");
  const site = url.pathname.split("/")[1] ?? "";
  const host = HOSTS[site];
  if (host === undefined) throw Error(`No distinct replica host for ${site}`);
  if (aliasesBound) url.hostname = `127.0.0.${host}`;
  return url.href;
}

async function canBindLoopbackAlias(): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.2", () => probe.close(() => resolve(true)));
  });
}

export async function startReplicaAliases(base: string): Promise<void> {
  aliasesBound = await canBindLoopbackAlias();
  if (!aliasesBound) {
    console.log(
      "[scoreboard] 127.0.0.2 cannot be bound here; every replica uses the fixture server's own host.",
    );
    return;
  }
  const response = await fetch(new URL("__scale__/manifest", base), {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(`Replica alias setup failed: ${response.status}`);
  await response.body?.cancel();
}
