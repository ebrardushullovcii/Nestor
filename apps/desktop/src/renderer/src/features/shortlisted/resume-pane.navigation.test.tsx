// @vitest-environment jsdom
import {
  JobDetailSchema,
  ResumeDraftSchema,
  type StoredResume,
} from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { ToastProvider } from "@renderer/components/ui/toast";
import { JobFinderKeptRoutesOutlet } from "@renderer/pages/job-finder-kept-routes";
import { ResumePane } from "./resume-pane";
import type { useResume } from "./use-resume";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("repeats edit after the person chooses Resume on the kept job, consumes requests and keeps the draft", async () => {
  const at = "2026-10-26T00:00:00.000Z";
  const draft = ResumeDraftSchema.parse({
    id: "synthetic-draft",
    jobId: "7",
    status: "draft",
    templateId: "classic_ats",
    createdAt: at,
    updatedAt: at,
  });
  const before = structuredClone(draft);
  const resume: StoredResume = {
    jobId: 7,
    level: "light",
    state: "ready",
    updatedAt: at,
    draft,
    approvedAt: null,
    error: null,
    previousLevel: null,
    levelChangeId: null,
    pdfPath: null,
    pdfSha256: null,
  };
  const job = JobDetailSchema.parse({
    id: 7,
    stage: "shortlisted",
    stageChangedAt: at,
    stageNote: null,
    title: "Synthetic analyst",
    company: "Synthetic employer",
    location: "Remote",
    workModes: ["remote"],
    salaryText: null,
    fitScore: null,
    fitSummary: null,
    postedAt: null,
    foundAt: at,
    searchId: null,
    sourceLabel: "Replica",
    sourceCount: 1,
    url: "https://example.test/jobs/7",
    applyUrl: null,
    seenAt: at,
    description: "Synthetic listing",
    summary: null,
    seniority: null,
    employmentType: null,
    salary: null,
    facts: {},
    fit: null,
    sightings: [],
  });
  const view = {
    job,
    resume,
    draft,
    templates: [],
    dirty: false,
    saveStatus: "saved",
    saveError: null,
    preview: null,
    previewError: null,
    edit: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    saveMyEdits: vi.fn(() => Promise.resolve()),
    loadSaved: vi.fn(),
    refresh: vi.fn(),
    setResume: vi.fn(),
  } satisfies ReturnType<typeof useResume>;
  function Nav() {
    const navigate = useNavigate();
    const location = useLocation();
    return (
      <nav>
        <button
          onClick={() =>
            void navigate("/job-finder/review-queue?jobId=7&resumeMode=edit")
          }
        >
          Request edit
        </button>
        <button
          onClick={() => void navigate("/job-finder/review-queue?jobId=7")}
        >
          Open normally
        </button>
        <output data-testid="route">{location.search}</output>
      </nav>
    );
  }
  render(
    <MemoryRouter initialEntries={["/job-finder/review-queue?jobId=7"]}>
      <ToastProvider>
        <Routes>
          <Route
            path="/job-finder"
            element={
              <>
                <Nav />
                <JobFinderKeptRoutesOutlet
                  context={null}
                  fallback={null}
                  readyMarker={null}
                />
              </>
            }
          >
            <Route
              path="review-queue"
              element={
                <ResumePane
                  view={view}
                  onApprove={() => undefined}
                  approving={false}
                  onApply={() => undefined}
                  applying={false}
                  onMoveBack={() => undefined}
                />
              }
            />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
  const pane = () => document.querySelector('[data-job-detail-id="7"]')!;
  fireEvent.click(screen.getByRole("button", { name: "Request edit" }));
  await waitFor(() =>
    expect(pane().getAttribute("data-resume-mode")).toBe("edit"),
  );
  await waitFor(() =>
    expect(screen.getByTestId("route").textContent).not.toContain("resumeMode"),
  );
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Read or edit the resume" }),
    ).getByRole("button", { name: /^Resume$/ }),
  );
  expect(pane().getAttribute("data-resume-mode")).toBe("read");
  fireEvent.click(screen.getByRole("button", { name: "Request edit" }));
  await waitFor(() =>
    expect(pane().getAttribute("data-resume-mode")).toBe("edit"),
  );
  await waitFor(() =>
    expect(screen.getByTestId("route").textContent).not.toContain("resumeMode"),
  );
  expect(
    document.querySelector('[data-resume-pane="edit"]')!.className,
  ).not.toContain("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Open normally" }));
  await waitFor(() =>
    expect(
      document.querySelector('[data-resume-pane="edit"]')!.className,
    ).toContain("2xl:flex"),
  );
  expect(draft).toEqual(before);
  expect(view.edit).not.toHaveBeenCalled();
});
