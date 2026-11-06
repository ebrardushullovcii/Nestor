import { spawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import { expect, test } from "vitest";
import { replicaUrl, startReplicaAliases } from "./replicas.ts";

test("the existing local server serves each site and its application on a distinct loopback host", async () => {
  const server = spawn(
    process.execPath,
    [path.resolve("apps/desktop/test-fixtures/job-sites/serve.mjs")],
    {
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(Error("Replica server did not start")),
        5000,
      );
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(Error("Replica server exited before startup"));
      });
      server.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url =
          /Local replica job sites: (http:\/\/127\.0\.0\.1:\d+\/)/u.exec(
            output,
          )?.[1];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      });
    });
    await startReplicaAliases(base);
    const sites = [
      "board",
      "greenhouse",
      "lever",
      "workday",
      "gatekeeper",
      "atlas",
      "ripple",
    ];
    for (const site of sites) {
      const listing = replicaUrl(
        base,
        `${site}/jobs/${site === "atlas" || site === "ripple" ? 100 : 1}`,
      );
      const response = await fetch(listing);
      expect(response.status, listing).toBe(200);
      expect(await response.text()).toContain("<h1");
      const apply = replicaUrl(
        base,
        `${site === "board" ? "employer-a" : site}/apply/${site === "atlas" || site === "ripple" ? 100 : 1}`,
      );
      expect(new URL(apply).origin).toBe(new URL(listing).origin);
      const form = await fetch(apply);
      expect(form.status, apply).toBe(200);
      await form.body?.cancel();
    }
  } finally {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
  }
}, 15000);
