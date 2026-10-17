import { once } from "node:events";
import path from "node:path";
import repl from "node:repl";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAgentSession } from "./session.mjs";
import { processConflicts } from "./support.mjs";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    doctor: { type: "boolean" },
    script: { type: "string" },
    provider: { type: "string", default: "deterministic" },
    trace: { type: "boolean", default: false },
    "no-fixtures": { type: "boolean", default: false },
    "parallel-group": { type: "string" },
    "session-id": { type: "string" },
  },
});

if (values.help) {
  console.log(`Development QA with the installed Playwright and Electron tools.

  pnpm --filter @nestor/desktop qa
  pnpm --filter @nestor/desktop qa --script /absolute/path/scenario.mjs
  pnpm --filter @nestor/desktop qa --provider configured
  pnpm --filter @nestor/desktop qa --doctor
  pnpm --filter @nestor/desktop qa --parallel-group job-finder-check --session-id lane-01

Default: fresh synthetic workspace, deterministic AI, embedded browser, private
copy of existing build, local fixture sites on a free port. No build or release
checks are run. Explicit NESTOR_BROWSER_HOST overrides are preserved.
--trace records Playwright traces (may include request data).
--no-fixtures skips the local sites.
--parallel-group explicitly permits isolated sessions in the same named group.
--session-id labels a parallel session; each active label must be distinct.
The default remains exclusive. Coordinate the build before starting any group.

REPL: qa.page, qa.context, qa.app are unrestricted Playwright objects.
Use await qa.capture('name') and qa.restart(). All other actions use Playwright
and the app's existing APIs directly.
Scripts export default async function (qa) { ... }.
.exit / Ctrl-D closes only owned processes and keeps artifacts.
See docs/AGENT_QA.md for examples, fault injection and evidence limits.`);
} else if (values.doctor) {
  const conflicts = await processConflicts();
  console.log(
    JSON.stringify(
      {
        conflicts,
        note: "Read-only process check. Also coordinate with other agents; older scripts do not use the shared QA lease.",
      },
      null,
      2,
    ),
  );
} else {
  let qa;
  let closing;
  let interrupted = false;
  const close = () =>
    (closing ??= (async () => {
      if (qa) {
        await qa.close();
        console.log(`QA artifacts retained: ${qa.runDir}`);
      }
    })());
  const signal = () => {
    interrupted = true;
    // Finish launch before closing its owned handles; never abandon a half-started app.
    if (!qa) return;
    void close().then(
      () => process.exit(130),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  try {
    qa = await createAgentSession({
      provider: values.provider,
      trace: values.trace,
      fixtures: !values["no-fixtures"],
      parallelGroup: values["parallel-group"],
      sessionId: values["session-id"],
    });
    if (interrupted) throw new Error("QA startup interrupted");
    console.log(
      `QA ready: ${qa.runDir}\nProvider: ${qa.provider}\nBrowser host (requested): ${qa.browserHost}\nFixtures: ${qa.sites?.url ?? "disabled"}`,
    );
    if (qa.parallelGroup)
      console.log(
        `Parallel group: ${qa.parallelGroup}; session: ${qa.sessionId}`,
      );
    console.log(qa.build.note);
    if (values.script) {
      const scenario = await import(
        pathToFileURL(path.resolve(values.script)).href
      );
      if (typeof scenario.default !== "function")
        throw new Error("Scenario must export a default async function (qa)");
      await scenario.default(qa);
    } else {
      if (!process.stdin.isTTY)
        throw new Error(
          "Use --script for non-interactive runs, or allocate a terminal for the QA REPL.",
        );
      const shell = repl.start({ prompt: "qa> ", useGlobal: false });
      shell.context.qa = qa;
      await once(shell, "exit");
    }
  } catch (error) {
    if (qa?.page && !qa.page.isClosed()) {
      await qa
        .capture(`failure-${Date.now()}`)
        .catch((captureError) =>
          console.error(`Failure capture: ${captureError.message}`),
        );
    }
    console.error(error);
    process.exitCode = 1;
  } finally {
    await close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    process.off("SIGTERM", signal);
    process.off("SIGINT", signal);
  }
}
