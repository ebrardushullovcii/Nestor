// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ResumeDraftSchema,
  type JobChange,
  type JobDetail,
  type ResumeCommandInput,
  type ResumeCommandName,
  type ResumeCommandOutputs,
  type StoredResume,
} from "@nestor/contracts";
import { useResume } from "./use-resume";

let saved: StoredResume;
let changed: ((event: JobChange) => void) | null;
const write =
  vi.fn<
    (input: {
      draft: StoredResume["draft"];
      expectedUpdatedAt: string;
    }) => Promise<StoredResume>
  >();
beforeEach(() => {
  changed = null;
  saved = {
    jobId: 1,
    level: "light",
    state: "ready",
    updatedAt: "2026-10-26T00:00:00.000Z",
    draft: ResumeDraftSchema.parse({
      id: "draft-1",
      jobId: "1",
      status: "draft",
      templateId: "classic_ats",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
    }),
    approvedAt: null,
    error: null,
    previousLevel: null,
    levelChangeId: null,
    pdfPath: null,
    pdfSha256: null,
  };
  write.mockReset();
  write.mockImplementation((input) => {
    if (input.expectedUpdatedAt !== saved.updatedAt)
      throw new Error("This resume changed since you opened it.");
    saved = {
      ...saved,
      draft: input.draft,
      updatedAt: new Date(Date.parse(saved.updatedAt) + 1).toISOString(),
    };
    return Promise.resolve(saved);
  });
  Object.assign(window, {
    nestor: {
      jobs: {
        onChange: (listener: typeof changed) => {
          changed = listener;
          return () => {
            changed = null;
          };
        },
      },
      resumes: {
        run: (
          name: string,
          input: Parameters<typeof write>[0] & { jobId?: number },
        ) =>
          name === "get_resume"
            ? Promise.resolve({
                job: { id: input.jobId ?? 1, title: "Designer" } as JobDetail,
                resume: { ...saved, jobId: input.jobId ?? 1 },
                templates: [],
              })
            : write(input),
        preview: () =>
          Promise.resolve({ html: "<p>Preview</p>", pageCount: 1 }),
      },
    },
  });
});
afterEach(cleanup);

it("keeps the newer read when an older queued snapshot arrives with the same timestamp", async () => {
  const { result } = renderHook(() => useResume(1));
  await waitFor(() => expect(result.current.resume?.state).toBe("ready"));
  const read = window.nestor.resumes.run.bind(window.nestor.resumes);
  let finish!: () => void;
  const heldRead = <K extends ResumeCommandName>(
    name: K,
    input: ResumeCommandInput<K>,
  ): Promise<ResumeCommandOutputs[K]> => {
    if (name !== "get_resume") return read(name, input);
    return new Promise<ResumeCommandOutputs["get_resume"]>((resolve) => {
      finish = () =>
        resolve({
          job: { id: 1, title: "Designer" } as JobDetail,
          resume: { ...saved, state: "queued" },
          templates: [],
        });
    }) as Promise<ResumeCommandOutputs[K]>;
  };
  vi.spyOn(window.nestor.resumes, "run").mockImplementationOnce(heldRead);
  act(() => {
    void result.current.refresh();
  });
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => {
    await result.current.refresh();
  });
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(result.current.resume?.state).toBe("ready");
});

it("opens another job while the previous job is still saving", async () => {
  const { result, rerender } = renderHook(({ id }) => useResume(id), {
    initialProps: { id: 1 },
  });
  await waitFor(() => expect(result.current.resume).not.toBeNull());
  let finish!: (value: StoredResume) => void;
  write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => result.current.edit({ ...saved.draft!, targetPageCount: 1 }));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.flush().catch(() => undefined);
  });
  rerender({ id: 2 });
  await waitFor(() => expect(result.current.job?.id).toBe(2));
  await act(async () => {
    finish(saved);
    await pending;
  });
  expect(result.current.job?.id).toBe(2);
  expect(result.current.resume?.jobId).toBe(2);
});

it("keeps unsaved typing across an external change, and replaces saved content only after the person chooses Save my edits", async () => {
  const { result } = renderHook(() => useResume(1));
  await waitFor(() => expect(result.current.resume).not.toBeNull());
  const revision = result.current.resume!.updatedAt;
  act(() => result.current.edit({ ...saved.draft!, targetPageCount: 1 }));
  saved = {
    ...saved,
    updatedAt: "2026-10-26T00:00:01.000Z",
    draft: { ...saved.draft!, targetPageCount: 3 },
  };
  act(() =>
    changed!({
      cause: "resume",
      ids: [1],
      stages: ["shortlisted"],
      searchId: null,
    }),
  );
  await waitFor(() => expect(result.current.saveStatus).toBe("failed"));
  expect(result.current.draft?.targetPageCount).toBe(1);
  expect(result.current.resume?.updatedAt).toBe(revision);
  await expect(result.current.flush()).rejects.toThrow("typing is kept");
  expect(write).not.toHaveBeenCalled();
  await act(() => result.current.saveMyEdits());
  expect(saved.draft?.targetPageCount).toBe(1);
  expect(result.current.dirty).toBe(false);
});

it("does not discard typing when a save conflicts, and loads saved content only on request", async () => {
  const { result } = renderHook(() => useResume(1));
  await waitFor(() => expect(result.current.resume).not.toBeNull());
  act(() => result.current.edit({ ...saved.draft!, targetPageCount: 1 }));
  write.mockRejectedValueOnce(
    new Error("This resume changed since you opened it."),
  );
  await act(async () => {
    await expect(result.current.flush()).rejects.toThrow();
  });
  expect(result.current.draft?.targetPageCount).toBe(1);
  expect(result.current.dirty).toBe(true);
  act(() => result.current.loadSaved());
  await waitFor(() => expect(result.current.draft?.targetPageCount).toBe(2));
  expect(result.current.dirty).toBe(false);
});

it("keeps newer typing when an in-flight save completes and refuses to approve or export the older edit", async () => {
  const { result } = renderHook(() => useResume(1));
  await waitFor(() => expect(result.current.resume).not.toBeNull());
  let finish!: (value: StoredResume) => void;
  write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => result.current.edit({ ...saved.draft!, targetPageCount: 1 }));
  let flush!: Promise<void>;
  act(() => {
    flush = result.current.flush();
  });
  act(() => result.current.edit({ ...saved.draft!, targetPageCount: 3 }));
  await act(async () => {
    finish({ ...saved, updatedAt: "2026-10-26T00:00:00.001Z" });
    await expect(flush).rejects.toThrow("typing is kept");
  });
  expect(result.current.draft?.targetPageCount).toBe(3);
  expect(result.current.dirty).toBe(true);
});
