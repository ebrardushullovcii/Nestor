// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createJobSitesStore,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import type { JobCommandName } from "@nestor/contracts";
import { ProfileJobSourcesTab } from "./profile-job-sources-tab";

vi.mock("@renderer/components/ui/toast", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
let store: JobStore;
let requests: { name: JobCommandName; input: unknown }[];
beforeEach(() => {
  store = openJobStore(":memory:");
  requests = [];
  const run = createJobCommandRunner({ store });
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobs: {
        run: (name: JobCommandName, input: unknown) => {
          requests.push({ name, input });
          return run(name, input);
        },
        onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
          store.onChange(listener),
      },
    },
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  store.close();
});
const props = {
  isSourceDebugPending: () => false,
  isSourceInstructionPending: () => false,
  isSourceInstructionVerifyPending: () => false,
  onGetSourceDebugRunDetails: () => Promise.reject(new Error("Not used")),
  onRunSourceDebug: vi.fn(),
  onSaveSourceInstructionArtifact: vi.fn(),
  onVerifySourceInstructions: vi.fn(),
  recentSourceDebugRuns: [],
  sourceInstructionArtifacts: [],
};

test("bulk add writes sites directly and explains duplicates", async () => {
  const sites = createJobSitesStore(store);
  sites.add({ text: "https://first.example.test/jobs" });
  render(<ProfileJobSourcesTab {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Add sources" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Job site URLs" }), {
    target: {
      value:
        "https://first.example.test/jobs\nhttps://second.example.test/jobs",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add and turn on" }));
  await screen.findByText(
    "Added and turned on 1 source. 1 was already in your list.",
  );
  expect(sites.counts().all).toBe(2);
  expect(requests.some((request) => request.name === "add_sites")).toBe(true);
});

test("900 sites stay paged; finding, editing and switching one never loads or saves a profile", async () => {
  const sites = createJobSitesStore(store);
  sites.add({
    text: Array.from(
      { length: 900 },
      (_, index) =>
        `https://board-${String(index).padStart(3, "0")}.example.test/jobs`,
    ).join("\n"),
  });
  const { container } = render(<ProfileJobSourcesTab {...props} />);
  await waitFor(() =>
    expect(container.querySelectorAll("[data-list-row-id]").length).toBe(25),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Find a source" }), {
    target: { value: "board-899" },
  });
  await waitFor(() =>
    expect(container.querySelectorAll("[data-list-row-id]").length).toBe(1),
  );
  const name = await screen.findByRole("textbox", { name: "Source name" });
  fireEvent.change(name, { target: { value: "My last board" } });
  fireEvent.blur(name);
  await waitFor(() => expect(sites.get(900)?.label).toBe("My last board"));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include this source in searches" }),
  );
  await waitFor(() => expect(sites.get(900)?.enabled).toBe(false));
  expect(sites.get(899)?.enabled).toBe(true);
  expect(sites.counts().all).toBe(900);
  expect(
    requests
      .filter((request) => request.name === "list_sites")
      .every((request) => (request.input as { limit: number }).limit === 25),
  ).toBe(true);
});
