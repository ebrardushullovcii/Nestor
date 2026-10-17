// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  TailoredAssetSchema,
  type TailoredAsset,
  type TailoredAssetSummary,
} from "@nestor/contracts";
import {
  clearTailoredAssetDetailCache,
  useTailoredAssetDetail,
} from "./use-tailored-asset-detail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearTailoredAssetDetailCache();
});
function asset(
  id = "a",
  contentText = "Current complete resume",
  version = "1",
) {
  return TailoredAssetSchema.parse({
    id,
    jobId: id,
    kind: "resume",
    status: "ready",
    label: id,
    version,
    templateName: "Classic",
    compatibilityScore: 90,
    progressPercent: 100,
    updatedAt: "2026-10-13T10:00:00.000Z",
    contentText,
    previewSections: [{ heading: "Summary", lines: [contentText] }],
  });
}
function summary(value: TailoredAsset): TailoredAssetSummary {
  const { contentText: _text, previewSections: _sections, ...metadata } = value;
  void _text;
  void _sections;
  return metadata;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bridge(read: (id: string) => Promise<TailoredAsset | null>) {
  vi.stubGlobal("nestor", { jobFinder: { getTailoredAsset: read } });
}

test("loads only the selected complete document and fences late replies after selection changes", async () => {
  const a = deferred<TailoredAsset>();
  const b = deferred<TailoredAsset>();
  const read = vi.fn((id: string) => (id === "a" ? a.promise : b.promise));
  bridge(read);
  const { result, rerender } = renderHook(
    ({ row }) => useTailoredAssetDetail(row),
    { initialProps: { row: summary(asset("a")) } },
  );
  await waitFor(() => expect(read).toHaveBeenCalledWith("a"));
  rerender({ row: summary(asset("b")) });
  expect(result.current.asset).toBeNull();
  await waitFor(() => expect(read).toHaveBeenCalledWith("b"));
  await act(() => {
    b.resolve(asset("b", "Selected B body"));
    return Promise.resolve();
  });
  expect(result.current.asset?.contentText).toBe("Selected B body");
  await act(() => {
    a.resolve(asset("a", "Late A body"));
    return Promise.resolve();
  });
  expect(result.current.asset?.contentText).toBe("Selected B body");
  expect(read).toHaveBeenCalledTimes(2);
});

test("reset invalidates a completed body and an in-flight read even with the same id/version/date", async () => {
  const old = deferred<TailoredAsset>();
  const restored = deferred<TailoredAsset>();
  const read = vi
    .fn()
    .mockResolvedValueOnce(asset("a", "Before reset"))
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(restored.promise);
  bridge(read);
  const row = summary(asset());
  const { result } = renderHook(() => useTailoredAssetDetail(row));
  await waitFor(() =>
    expect(result.current.asset?.contentText).toBe("Before reset"),
  );
  act(clearTailoredAssetDetailCache);
  expect(result.current.asset).toBeNull();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  act(clearTailoredAssetDetailCache);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  await act(() => {
    restored.resolve(asset("a", "Restored same metadata"));
    return Promise.resolve();
  });
  await act(() => {
    old.resolve(asset("a", "Late pre-restore body"));
    return Promise.resolve();
  });
  expect(result.current.asset?.contentText).toBe("Restored same metadata");
});

test("replaced summary identity invalidates same metadata; mismatched revisions never display and retry loads current data", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(asset("a", "Initial"))
    .mockResolvedValueOnce(asset("a", "Wrong revision", "2"))
    .mockResolvedValueOnce(asset("a", "Restored current body"));
  bridge(read);
  const { result, rerender } = renderHook(
    ({ row }) => useTailoredAssetDetail(row),
    { initialProps: { row: summary(asset()) } },
  );
  await waitFor(() =>
    expect(result.current.asset?.contentText).toBe("Initial"),
  );
  rerender({ row: summary(asset()) });
  expect(result.current.asset).toBeNull();
  await waitFor(() => expect(result.current.error).toContain("changed while"));
  expect(result.current.asset).toBeNull();
  act(result.current.retry);
  await waitFor(() =>
    expect(result.current.asset?.contentText).toBe("Restored current body"),
  );
});

test("clearing selection releases the body and ignores its pending reply", async () => {
  const request = deferred<TailoredAsset>();
  const read = vi.fn().mockReturnValue(request.promise);
  bridge(read);
  const { result, rerender } = renderHook(
    ({ row }) => useTailoredAssetDetail(row),
    { initialProps: { row: summary(asset()) as TailoredAssetSummary | null } },
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  rerender({ row: null });
  await act(() => {
    request.resolve(asset());
    return Promise.resolve();
  });
  expect(result.current.asset).toBeNull();
  expect(result.current.loading).toBe(false);
});
