// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  openJobStore,
  createJobSitesStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import { SetupSites } from "@renderer/features/job-lists/setup-sites";
afterEach(cleanup);
test("setup flushes pasted URLs before continuing, retaining duplicate feedback", async () => {
  const store = openJobStore(":memory:");
  try {
    const run = createJobCommandRunner({ store });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobs: {
          run,
          onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
            store.onChange(listener),
        },
      },
    });
    const flush = vi.fn<() => Promise<void>>();
    render(
      <SetupSites
        registerFlush={(next) => {
          if (next) flush.mockImplementation(next);
        }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Job site URLs" }), {
      target: {
        value:
          "https://employer.example.test/jobs\nhttps://employer.example.test/jobs",
      },
    });
    await act(async () => {
      await flush();
    });
    expect(createJobSitesStore(store).counts()).toMatchObject({
      all: 1,
      enabled: 1,
    });
    await screen.findByText(
      "Added and turned on 1 source. 1 was already in your list.",
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Job site URLs",
      }).value,
    ).toBe("");
  } finally {
    cleanup();
    store.close();
  }
});
