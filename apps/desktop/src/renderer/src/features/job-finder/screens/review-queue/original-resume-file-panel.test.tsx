// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResumeSourceDocumentSchema } from "@nordri/contracts";
import { OriginalResumeFilePanel } from "./original-resume-file-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each(["pdf", "docx"])(
  "shows and opens the actual original %s attachment",
  async (extension) => {
    const source = ResumeSourceDocumentSchema.parse({
      id: "source",
      fileName: `resume.${extension}`,
      uploadedAt: "2026-10-01T12:00:00.000Z",
    });
    const openCandidateAsset = vi.fn().mockResolvedValue({ outcome: "opened" });
    const listCandidateAssets = vi.fn().mockResolvedValue({
      assets: [],
      originalResumeFile: {
        id: source.id,
        fileName: source.fileName,
        fileType: extension.toUpperCase(),
        byteSize: 4096,
        importedAt: source.uploadedAt,
      },
    });
    vi.stubGlobal("nordri", {
      jobFinder: { openCandidateAsset, listCandidateAssets },
    });
    render(<OriginalResumeFilePanel source={source} />);
    const button = await screen.findByRole("button", { name: "Open file" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(
      screen.getByText(
        new RegExp(`${extension.toUpperCase()} · 4.0 KB · Imported`),
      ),
    ).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() =>
      expect(openCandidateAsset).toHaveBeenCalledWith({ assetId: source.id }),
    );
    expect(listCandidateAssets).toHaveBeenCalledWith({
      includeDeleted: false,
      resumeSourceId: source.id,
    });
  },
);
