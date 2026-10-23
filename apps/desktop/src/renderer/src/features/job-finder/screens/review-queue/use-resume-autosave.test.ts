// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ResumeDraft } from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResumeAutosave, type ResumeAutosave } from "./use-resume-autosave";

function draft(text: string, id = "draft-1"): ResumeDraft {
  return { id, jobId: "job-1", sections: [{ text }] } as unknown as ResumeDraft;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(save: ResumeAutosave) {
  const onSaved = vi.fn();
  const hook = renderHook(
    (props: { draft: ResumeDraft; unsaved: boolean }) =>
      useResumeAutosave({
        contentKey: JSON.stringify(props.draft.sections),
        draft: props.draft,
        onSaved,
        save,
        unsaved: props.unsaved,
      }),
    { initialProps: { draft: draft("a"), unsaved: false } },
  );
  return { hook, onSaved };
}

describe("useResumeAutosave", () => {
  it("saves once, a second after the last edit", async () => {
    const save = vi.fn<ResumeAutosave>((_draft, onSaved) => {
      onSaved("2026-10-23T00:00:00.000Z");
      return Promise.resolve({ saved: true });
    });
    const { hook, onSaved } = setup(save);
    hook.rerender({ draft: draft("ab"), unsaved: true });
    expect(hook.result.current.status).toBe("saving");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    hook.rerender({ draft: draft("abc"), unsaved: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual(draft("abc"));
    expect(onSaved).toHaveBeenCalledWith(
      draft("abc"),
      "2026-10-23T00:00:00.000Z",
    );
    hook.rerender({ draft: draft("abc"), unsaved: false });
    expect(hook.result.current.status).toBe("saved");
  });

  it("does not retry a failed save until the next edit", async () => {
    const save = vi.fn<ResumeAutosave>(() =>
      Promise.resolve({ saved: false, message: "Not saved." }),
    );
    const { hook } = setup(save);
    hook.rerender({ draft: draft("ab"), unsaved: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook.result.current.status).toBe("failed");
    expect(hook.result.current.failure).toBe("Not saved.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    hook.rerender({ draft: draft("abc"), unsaved: true });
    expect(hook.result.current.status).toBe("saving");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("saves pending edits at once when the editor closes", () => {
    const save = vi.fn<ResumeAutosave>(() => Promise.resolve({ saved: true }));
    const { hook } = setup(save);
    hook.rerender({ draft: draft("ab"), unsaved: true });
    hook.unmount();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual(draft("ab"));
  });

  it("saves the old draft's edits when another job's draft opens", () => {
    const save = vi.fn<ResumeAutosave>(() => Promise.resolve({ saved: true }));
    const { hook } = setup(save);
    hook.rerender({ draft: draft("ab"), unsaved: true });
    hook.rerender({ draft: draft("other", "draft-2"), unsaved: false });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual(draft("ab"));
  });
});
