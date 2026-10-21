import { expect, test, vi } from "vitest";
import {
  createDocumentManager,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

test("an unchanged draft is previewed once; a change renders again", async () => {
  const base = createDocumentManager();
  const render = vi.fn(base.renderResumePreview.bind(base));
  const { workspaceService } = createWorkspaceServiceHarness({
    documentManager: { ...base, renderResumePreview: render },
  });
  const workspace = await workspaceService.getResumeWorkspace("job_ready");

  const first = await workspaceService.previewResumeDraft(workspace.draft);
  const again = await workspaceService.previewResumeDraft(workspace.draft);
  expect(again).toBe(first);
  expect(render).toHaveBeenCalledTimes(1);

  const edited = {
    ...workspace.draft,
    sections: workspace.draft.sections.map((section, index) =>
      index === 0 ? { ...section, label: `${section.label} edited` } : section,
    ),
  };
  const changed = await workspaceService.previewResumeDraft(edited);
  expect(changed).not.toBe(first);
  expect(render).toHaveBeenCalledTimes(2);

  // A profile edit can change what any draft says, so it renders again.
  const snapshot = await workspaceService.getWorkspaceSnapshot();
  await workspaceService.saveProfile({
    ...snapshot.profile,
    headline: `${snapshot.profile.headline} and mentor`,
  });
  await workspaceService.previewResumeDraft(workspace.draft);
  expect(render).toHaveBeenCalledTimes(3);
});
