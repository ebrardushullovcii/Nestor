import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ACTION_INVENTORY } from "./inventory";
import { buildOutcomeReport, type ObservedAction } from "./outcome";

const artifactSchema = z.object({
  version: z.literal(1),
  environment: z.object({
    buildCommit: z.string().min(1),
    buildChangesHash: z.string().nullable(),
    label: z.string().min(1),
    ai: z.literal("live"),
    net: z.literal("replica"),
    doctorPassed: z.literal(true),
  }),
  observations: z.array(
    z.object({
      id: z.string().min(1),
      actionId: z.string().min(1),
      request: z.string().min(1),
      expected: z.enum(["completed", "correctly_blocked"]),
      throughChat: z.boolean().default(false),
      assertions: z.array(
        z.object({
          label: z.string(),
          kind: z.enum(["data", "visible_state", "file", "guard", "unchanged"]),
          source: z.string(),
          actual: z.unknown(),
          expected: z.unknown(),
          passed: z.boolean(),
        }),
      ),
      blockedReason: z.string().optional(),
      unsupportedReason: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
type Artifact = z.infer<typeof artifactSchema>;

/** Independent short app runs may share coverage only for the identical build. */
export function combineOutcomeArtifacts(inputs: readonly unknown[]) {
  if (!inputs.length) throw Error("Give at least one observation artifact");
  const artifacts = inputs.map((input) => artifactSchema.parse(input));
  const build = artifacts[0]!.environment;
  if (
    artifacts.some(
      ({ environment }) =>
        environment.buildCommit !== build.buildCommit ||
        environment.buildChangesHash !== build.buildChangesHash,
    )
  )
    throw Error(
      "Cannot combine different builds; rerun cases on the current build",
    );
  const observations = artifacts.flatMap((artifact, index) =>
    artifact.observations.map(
      (observation): ObservedAction => ({
        actionId: observation.actionId,
        request: observation.request,
        expected: observation.expected,
        throughChat: observation.throughChat,
        ...(observation.blockedReason === undefined
          ? {}
          : { blockedReason: observation.blockedReason }),
        ...(observation.unsupportedReason === undefined
          ? {}
          : { unsupportedReason: observation.unsupportedReason }),
        ...(observation.error === undefined
          ? {}
          : { error: observation.error }),
        // Keep repeat failures. A later passing attempt must not erase them.
        id: `run-${index + 1}.${observation.id}`,
        assertions: observation.assertions.map((assertion) => ({
          ...assertion,
          actual: assertion.actual,
          expected: assertion.expected,
        })),
      }),
    ),
  );
  return {
    report: buildOutcomeReport(ACTION_INVENTORY, observations),
    environments: artifacts.map((artifact) => artifact.environment),
    observations,
  };
}

export async function merge(options: { files: string[]; output: string }) {
  const inputs: Artifact[] = [];
  for (const file of options.files)
    inputs.push(artifactSchema.parse(JSON.parse(await readFile(file, "utf8"))));
  const result = combineOutcomeArtifacts(inputs);
  await mkdir(options.output, { recursive: true });
  await writeFile(
    path.join(options.output, "assistant-outcomes.json"),
    JSON.stringify(
      {
        ...result.report,
        sources: options.files.map((file, index) => ({
          file: path.resolve(file),
          environment: result.environments[index],
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      inventoryTotal: result.report.inventoryTotal,
      counts: result.report.counts,
      passed: result.report.passed,
      sources: options.files.length,
    }),
  );
  return result.report;
}
