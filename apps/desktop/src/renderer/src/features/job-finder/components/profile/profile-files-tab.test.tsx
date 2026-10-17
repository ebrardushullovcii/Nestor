// @vitest-environment jsdom

import type { CandidateAsset } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileFilesTab } from "./profile-files-tab";

const asset: CandidateAsset = {
  id: "asset_1",
  kind: "portfolio",
  originalName: "portfolio.pdf",
  mime: "application/pdf",
  byteSize: 2048,
  sha256: "a".repeat(64),
  createdAt: "2026-08-10T10:00:00.000Z",
  sensitivity: "sensitive",
  consentScope: "job_application_attachment",
  retention: "until_deleted",
  deletedAt: null,
  extractedText: null,
  forJob: null,
};

const removedAsset: CandidateAsset = {
  ...asset,
  deletedAt: new Date(Date.now() - 60_000).toISOString(),
  lifecycle: {
    retentionStartedAt: asset.createdAt,
    expiresAt: null,
    deletionReason: "removed",
    purgeAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ProfileFilesTab", () => {
  it("hides a removed file once its seven-day window has passed", async () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn().mockResolvedValue({
            assets: [
              {
                ...removedAsset,
                deletedAt: new Date(
                  Date.now() - 8 * 24 * 60 * 60 * 1_000,
                ).toISOString(),
              },
            ],
          }),
        },
      },
    });
    render(<ProfileFilesTab />);
    await flush();
    expect(screen.queryByRole("list", { name: "Removed files" })).toBeNull();
  });

  it("adds a file as attachable, removes it to a reversible Removed list, and restores it", async () => {
    const listCandidateAssets = vi
      .fn()
      .mockResolvedValueOnce({ assets: [] })
      .mockResolvedValueOnce({ assets: [asset] })
      .mockResolvedValueOnce({ assets: [removedAsset] })
      .mockResolvedValueOnce({ assets: [asset] });
    const importCandidateAsset = vi
      .fn()
      .mockResolvedValue({ status: "imported", asset });
    const deleteCandidateAsset = vi
      .fn()
      .mockResolvedValue({ asset: removedAsset });
    const restoreCandidateAsset = vi.fn().mockResolvedValue({ asset });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets,
          importCandidateAsset,
          deleteCandidateAsset,
          restoreCandidateAsset,
        },
      },
    });

    render(<ProfileFilesTab />);
    await flush();
    expect(screen.getByText(/No files yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add a file" }));
    await flush();
    // One choice only: what the file is. It is always attachable and kept
    // until removed; the old consent and retention pickers are gone.
    expect(importCandidateAsset).toHaveBeenCalledWith({
      kind: "portfolio",
      sensitivity: "sensitive",
      consentScope: "job_application_attachment",
      retention: "until_deleted",
    });
    expect(screen.queryByLabelText(/How may Job Finder use it/)).toBeNull();
    expect(screen.queryByLabelText(/How long/)).toBeNull();
    const files = screen.getByRole("list", { name: "Your files" });
    expect(within(files).getByText("portfolio.pdf")).toBeTruthy();
    expect(within(files).getByText(/Portfolio · 2 KB · Added/)).toBeTruthy();

    // Remove goes straight to the reversible list; no confirm dialog.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove portfolio.pdf" }),
    );
    await flush();
    expect(deleteCandidateAsset).toHaveBeenCalledWith({ assetId: "asset_1" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const removed = screen.getByRole("list", { name: "Removed files" });
    expect(within(removed).getByText("portfolio.pdf")).toBeTruthy();
    expect(within(removed).getByText(/Deleted for good on/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore portfolio.pdf" }),
    );
    await flush();
    expect(restoreCandidateAsset).toHaveBeenCalledWith({
      assetId: "asset_1",
      retention: "until_deleted",
    });
    expect(screen.getByRole("list", { name: "Your files" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Removed files" })).toBeNull();
  });

  it("keeps a cancelled picker quiet and reports a load failure with a retry", async () => {
    const listCandidateAssets = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk"))
      .mockResolvedValueOnce({ assets: [] });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets,
          importCandidateAsset: vi
            .fn()
            .mockResolvedValue({ status: "cancelled" }),
        },
      },
    });
    render(<ProfileFilesTab />);
    await flush();
    expect(screen.getByRole("status").textContent).toBe(
      "Your files could not be loaded.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a file" }));
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("starts on the kind the card asked for when opened from a transcript card", async () => {
    const importCandidateAsset = vi
      .fn()
      .mockResolvedValue({ status: "cancelled" });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn().mockResolvedValue({ assets: [] }),
          importCandidateAsset,
          deleteCandidateAsset: vi.fn(),
          restoreCandidateAsset: vi.fn(),
        },
      },
    });
    render(<ProfileFilesTab requestedKind="transcript" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add a file" }));
    await flush();
    expect(importCandidateAsset).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transcript" }),
    );
  });

  it("starts on the first asked-for kind the person has no file of yet", async () => {
    const importCandidateAsset = vi
      .fn()
      .mockResolvedValue({ status: "cancelled" });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          // A portfolio is already there; the card asked for both.
          listCandidateAssets: vi.fn().mockResolvedValue({ assets: [asset] }),
          importCandidateAsset,
          deleteCandidateAsset: vi.fn(),
          restoreCandidateAsset: vi.fn(),
        },
      },
    });
    render(<ProfileFilesTab requestedKind="portfolio,transcript" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add a file" }));
    await flush();
    expect(importCandidateAsset).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transcript" }),
    );
  });
});
