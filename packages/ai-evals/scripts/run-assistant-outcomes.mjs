import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const help = `Assistant UI outcome eval — the built app, live chat and synthetic replica data.

Usage:
  pnpm --filter @nestor/ai-evals assistant-outcomes --help
  pnpm --filter @nestor/ai-evals assistant-outcomes --list
  pnpm --filter @nestor/ai-evals assistant-outcomes --out <outside-repo-directory> [--build]
  pnpm --filter @nestor/ai-evals assistant-outcomes --case navigation --out <directory>

--list          Print the full action map, exclusions and implemented case IDs. No app starts.
--case PREFIX   Run matching action IDs, plus their prerequisite batches. Repeatable.
--out PATH      Result directory, outside the checkout. Defaults under ~/Projects/nestor-agent-work.
--label NAME    Isolated instance label (default: assistant-outcomes-<timestamp>).
--build         Build and stamp the desktop before running; otherwise require a matching build.

The run launches its own verify-nestor instance, passes doctor, submits requests through
the visible Assistant composer and reads resulting data, files and visible controls.
It always closes only its own instance. Coordinate the build and built-app slot using
the workspace's rules; the CLI does not manage a machine-specific lock.

Each action is completed, correctly_blocked, unsupported or failed. A tool call or refusal
alone cannot pass. Blocked cases require the actual guard and unchanged protected state.
Unexercised actions remain failed (not_exercised) in the full denominator, even on a subset run.
Chat-management exclusions remain listed with reasons. Scripted-model reachability is not
an outcome result. Sends are restricted by verify-nestor to this run's loopback replicas.

Artifacts: assistant-outcomes.json, assistant-observations.json, conversations, screenshots,
replica receipts and final databases. Exit 0 requires the entire non-excluded map to pass;
exit 1 includes failed/unsupported/unexercised actions; exit 2 is setup/usage failure.
`;

const { values } = parseArgs({
  args: process.argv
    .slice(2)
    .filter((arg, index) => !(index === 0 && arg === "--")),
  options: {
    help: { type: "boolean", short: "h" },
    list: { type: "boolean" },
    case: { type: "string", multiple: true },
    out: { type: "string" },
    label: { type: "string" },
    build: { type: "boolean" },
  },
});
if (values.help) {
  console.log(help);
} else {
  const label = values.label ?? `assistant-outcomes-${Date.now()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(label))
    throw Error("Invalid label");
  const output = path.resolve(
    values.out ?? path.join(os.homedir(), "Projects/nestor-agent-work", label),
  );
  const runNode = (args, env = process.env) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env,
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  const journey = path.join(
    root,
    "packages/ai-evals/scripts/assistant-outcomes-journey.mjs",
  );
  if (values.list) {
    process.exitCode = await runNode([journey, "--list"]);
  } else {
    const relativeOutput = path.relative(root, output);
    if (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== "..")
      throw Error("Results must be outside the repository");
    await mkdir(output, { recursive: true });
    const resolved = await realpath(output);
    const relative = path.relative(await realpath(root), resolved);
    if (!relative.startsWith(`..${path.sep}`) && relative !== "..")
      throw Error("Results must be outside the repository");
    const env = {
      ...process.env,
      NESTOR_VERIFY_LABEL: label,
      NESTOR_VERIFY_WORK: resolved,
    };
    const verify = path.join(
      root,
      ".claude/skills/verify-nestor/bin/lib/cli.mjs",
    );
    const command = (...args) => runNode([verify, ...args], env);
    let launched = false;
    try {
      if (values.build && (await command("build")) !== 0)
        throw Error("Desktop build failed");
      launched = true; // down also cleans up a partially failed up.
      if ((await command("up", "--ai", "live")) !== 0)
        throw Error("Isolated app launch failed");
      if ((await command("doctor")) !== 0)
        throw Error("Doctor did not pass; refusing to drive");
      const status = await command(
        "drive",
        "run",
        journey,
        JSON.stringify({ prefixes: values.case ?? [], label }),
      );
      process.exitCode = status;
      await writeFile(
        path.join(output, "run.json"),
        JSON.stringify(
          {
            label,
            evidence: path.join(output, label, "verify"),
            exitCode: status,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    } finally {
      if (launched && (await command("down", "--keep-data")) !== 0)
        process.exitCode = 2;
    }
  }
}
