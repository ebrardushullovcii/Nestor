/** Reuse the scale manifest's loopback aliases; no DNS or hosts-file changes.
 * A board's listing and application stay on the same origin for session cookies.
 */
const HOSTS: Readonly<Record<string, number>> = {
  board: 2,
  "employer-a": 2,
  greenhouse: 3,
  lever: 4,
  workday: 5,
  gatekeeper: 6,
  atlas: 7,
  ripple: 8,
  pacer: 9,
  slowgrove: 10,
  framehire: 11,
  authboard: 12,
};

export function replicaUrl(base: string, pathname: string): string {
  const url = new URL(pathname, base);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw Error("Scoreboard replicas require the local fixture server");
  const site = url.pathname.split("/")[1] ?? "";
  const host = HOSTS[site];
  if (host === undefined) throw Error(`No distinct replica host for ${site}`);
  url.hostname = `127.0.0.${host}`;
  return url.href;
}

export async function startReplicaAliases(base: string): Promise<void> {
  const response = await fetch(new URL("__scale__/manifest", base), {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(`Replica alias setup failed: ${response.status}`);
  await response.body?.cancel();
}
