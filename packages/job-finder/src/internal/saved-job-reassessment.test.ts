import { expect, test, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import { reassessSavedJobs } from "./saved-job-reassessment";

test("unchanged goals reuse validated rows without a whole-job delta or discovery commit", async () => {
  const { repository } = createWorkspaceServiceHarness();
  const persistDiscoveryState = vi.fn(
    repository.commitDiscoveryStateUpdate.bind(repository),
  );
  const context = {
    repository,
    persistDiscoveryState,
    getActiveCampaignId: () => Promise.resolve(null),
  };
  await reassessSavedJobs(context);
  const before = await repository.listSavedJobs();
  const full = vi.spyOn(repository, "listSavedJobs");
  const delta = vi.spyOn(repository, "commitSavedJobDelta");
  const discovery = vi.spyOn(repository, "getDiscoveryState");
  persistDiscoveryState.mockClear();
  await reassessSavedJobs(context);
  expect(full).not.toHaveBeenCalled();
  expect(discovery).not.toHaveBeenCalled();
  expect(delta).not.toHaveBeenCalled();
  expect(persistDiscoveryState).not.toHaveBeenCalled();
  expect(await repository.listSavedJobs()).toEqual(before);
});
