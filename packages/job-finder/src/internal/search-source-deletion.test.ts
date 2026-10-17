import { SavedJobDiscoveryProvenanceSchema } from "@nestor/contracts";
import { expect, it } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-harness";
it("keeps saved jobs and their original board name when their source is deleted", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  const before = await workspaceService.getWorkspaceSnapshot();
  const source = before.searchPreferences.discovery.targets[0]!;
  const job = (await repository.listSavedJobs())[0]!;
  await repository.commitSavedJobDelta({
    upserts: [
      {
        ...job,
        provenance: [
          SavedJobDiscoveryProvenanceSchema.parse({
            targetId: source.id,
            startingUrl: source.startingUrl,
            adapterKind: "auto",
            discoveredAt: "2026-10-05T00:00:00.000Z",
          }),
        ],
      },
    ],
  });
  await workspaceService.saveSearchPreferences({
    ...before.searchPreferences,
    discovery: {
      ...before.searchPreferences.discovery,
      targets: before.searchPreferences.discovery.targets.filter(
        (target) => target.id !== source.id,
      ),
    },
  });
  const after = (await repository.listSavedJobs()).find(
    (saved) => saved.id === job.id,
  )!;
  expect(after.provenance[0]?.sourceLabel).toBe(source.label);
  expect(after.title).toBe(job.title);
});
