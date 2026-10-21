import { createOpenAiCompatibleJobFinderAiClient } from "@nestor/ai-providers";
import { expect, test, vi } from "vitest";
import {
  createSeed,
  createAiClient,
  createDocumentManager,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function fixture(count: number) {
  const seed = createSeed();
  const base = seed.savedJobs.find((job) => job.id === "job_ready")!;
  seed.savedJobs = Array.from({ length: count }, (_, i) => ({
    ...base,
    id: `pipeline_${i}`,
    canonicalUrl: `https://example.test/pipeline/${i}`,
    planAssessments: {},
  }));
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  return seed;
}

test("200 jobs roll from 50 writers into two local processors without workspace bodies", async () => {
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  const modelWaiters: Array<() => void> = [];
  let activeModels = 0,
    peakModels = 0,
    startedModels = 0;
  aiClient.createResumeDraft = async (input) => {
    startedModels++;
    activeModels++;
    peakModels = Math.max(peakModels, activeModels);
    await new Promise<void>((resolve) => modelWaiters.push(resolve));
    try {
      return await original(input);
    } finally {
      activeModels--;
    }
  };
  const documentManager = createDocumentManager();
  const render = documentManager.renderResumeArtifact.bind(documentManager);
  let releaseLocal!: () => void;
  const localGate = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  let activeLocal = 0,
    peakLocal = 0,
    startedLocal = 0;
  documentManager.renderResumeArtifact = async (input) => {
    startedLocal++;
    activeLocal++;
    peakLocal = Math.max(peakLocal, activeLocal);
    try {
      await localGate;
      return await render(input);
    } finally {
      activeLocal--;
    }
  };
  const seed = fixture(200);
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    documentManager,
  });
  const allAssets = vi.spyOn(repository, "listTailoredAssets");
  const allJobs = vi.spyOn(repository, "listSavedJobs");
  const stages = new Map<string, string>();
  let observedProcessingPeak = 0;
  const results = seed.savedJobs.map((job) =>
    workspaceService.generateResumeForBatch(job.id, {
      shouldStop: () => false,
      onStage: (stage) => {
        if (stage === "finished") stages.delete(job.id);
        else stages.set(job.id, stage);
        observedProcessingPeak = Math.max(
          observedProcessingPeak,
          [...stages.values()].filter((value) => value === "processing").length,
        );
      },
    }),
  );
  await vi.waitFor(() => expect(startedModels).toBe(50));
  modelWaiters.splice(0).forEach((resolve) => resolve());
  await vi.waitFor(() => expect(startedModels).toBe(100));
  await vi.waitFor(() => expect(startedLocal).toBe(2));
  // Another fifty writers are already running while the first PDFs are held.
  expect(activeModels).toBe(50);
  modelWaiters.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(startedModels).toBe(100); // admission prevents an unbounded ready-draft buffer
  releaseLocal();
  const pump = setInterval(
    () => modelWaiters.splice(0).forEach((resolve) => resolve()),
    5,
  );
  let receipts;
  try {
    receipts = await Promise.all(results);
  } finally {
    clearInterval(pump);
  }
  expect(receipts).toHaveLength(200);
  expect(
    receipts.every(
      (receipt) =>
        receipt.outcome === "written" || receipt.outcome === "fallback",
    ),
  ).toBe(true);
  expect(
    receipts.every(
      (receipt) => Object.keys(receipt).sort().join() === "jobId,outcome",
    ),
  ).toBe(true);
  expect(peakModels).toBe(50);
  expect(peakLocal).toBe(2);
  expect(observedProcessingPeak).toBe(2);
  expect(allAssets).not.toHaveBeenCalled();
  expect(allJobs).not.toHaveBeenCalled();
  expect((await repository.listResumeDrafts()).length).toBe(200);
  await workspaceService.shutdown();
}, 30_000);

test("Stop prevents waiting writers from starting; active results finish and can be retried", async () => {
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  let stop = false;
  let started = 0;
  const waiters: Array<() => void> = [];
  aiClient.createResumeDraft = async (input) => {
    started++;
    await new Promise<void>((resolve) => waiters.push(resolve));
    if (input.job.canonicalUrl.endsWith("/0"))
      throw new Error("Synthetic timeout");
    return original(input);
  };
  const seed = fixture(120);
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  const results = seed.savedJobs.map((job) =>
    workspaceService
      .generateResumeForBatch(job.id, { shouldStop: () => stop })
      .catch(() => ({ jobId: job.id, outcome: "failed" })),
  );
  await vi.waitFor(() => expect(started).toBe(50));
  stop = true;
  waiters.splice(0).forEach((resolve) => resolve());
  const receipts = await Promise.all(results);
  expect(started).toBe(50);
  expect(
    receipts.filter((receipt) => receipt.outcome === "not_started"),
  ).toHaveLength(70);
  expect((await repository.listResumeDrafts()).length).toBe(49);
  expect(
    (await repository.getTailoredAssetByJobId("pipeline_0"))?.failureMessage,
  ).toContain("Synthetic timeout");
  await workspaceService.shutdown();
}, 30_000);

test("reset during a writer keeps late success and failure out of restored rows", async () => {
  for (const fail of [false, true]) {
    const aiClient = createAiClient();
    const original = aiClient.createResumeDraft.bind(aiClient);
    let finish!: () => void;
    let started = false;
    aiClient.createResumeDraft = async (input) => {
      started = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (fail) throw new Error("Late synthetic timeout");
      return original(input);
    };
    const seed = fixture(1);
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient,
    });
    const pending = workspaceService.generateResumeForBatch("pipeline_0", {
      shouldStop: () => false,
    });
    await vi.waitFor(() => expect(started).toBe(true));
    await workspaceService.resetWorkspace(seed);
    finish();
    expect((await pending).outcome).toBe("cancelled");
    expect(await repository.getResumeDraftByJobId("pipeline_0")).toBeNull();
    expect(await repository.getTailoredAssetByJobId("pipeline_0")).toBeNull();
    await workspaceService.shutdown();
  }
});

test("reset aborts the writer request and frees capacity for the restored workspace", async () => {
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  let signal: AbortSignal | undefined;
  aiClient.createResumeDraft = (input) => {
    signal = input.signal;
    return new Promise((_resolve, reject) => {
      input.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Workspace replaced", "AbortError")),
        { once: true },
      );
    });
  };
  const seed = fixture(1);
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  const pending = workspaceService.generateResumeForBatch("pipeline_0", {
    shouldStop: () => false,
  });
  await vi.waitFor(() => expect(signal).toBeDefined());
  await workspaceService.resetWorkspace(seed);
  expect(signal?.aborted).toBe(true);
  expect((await pending).outcome).toBe("cancelled");
  expect(await repository.getTailoredAssetByJobId("pipeline_0")).toBeNull();
  aiClient.createResumeDraft = original;
  expect(
    (
      await workspaceService.generateResumeForBatch("pipeline_0", {
        shouldStop: () => false,
      })
    ).outcome,
  ).toMatch(/written|fallback/);
  await workspaceService.shutdown();
});

test("resume listing reads share the 50-writer capacity and ask for no fit verdict", async () => {
  const seed = fixture(60);
  seed.savedJobs = seed.savedJobs.map((job) => ({
    ...job,
    detailQuality: "card_only",
    listingDetailFetch: null,
    matchAssessment: {
      ...job.matchAssessment,
      requirementsSource: "deterministic",
    },
  }));
  const aiClient = createAiClient();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    peak = 0,
    started = 0;
  aiClient.extractJobsFromPage = async (input) => {
    started++;
    active++;
    peak = Math.max(peak, active);
    try {
      await wait;
      return [
        {
          ...seed.savedJobs[0]!,
          canonicalUrl: input.pageUrl,
          description:
            seed.savedJobs[0]!.description +
            " Additional accessible product interface and state management responsibilities.",
          detailQuality: "detail_enriched",
        },
      ];
    } finally {
      active--;
    }
  };
  // The writer needs the listing's text, not a fresh verdict.
  const assess = vi.fn(aiClient.assessJobFit.bind(aiClient));
  aiClient.assessJobFit = assess;
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    fetchListingHtml: (url) =>
      Promise.resolve({
        status: 200,
        html: `<article>Senior frontend engineer building accessible React interfaces with TypeScript. Work with a product team, deliver feature improvements, own state management and collaborate on design systems.</article><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: seed.savedJobs[0]!.title, description: seed.savedJobs[0]!.description + " Additional accessible product interface and state management responsibilities.", hiringOrganization: { "@type": "Organization", name: seed.savedJobs[0]!.company }, url })}</script>`,
        finalUrl: url,
      }),
  });
  const pending = seed.savedJobs.map((job) =>
    workspaceService.generateResumeForBatch(job.id, {
      shouldStop: () => false,
    }),
  );
  try {
    await vi.waitFor(() => expect(started).toBe(50));
    expect(active).toBe(50);
  } finally {
    release();
  }
  const receipts = await Promise.all(pending);
  expect(
    receipts.every(
      (receipt) =>
        receipt.outcome === "written" || receipt.outcome === "fallback",
    ),
  ).toBe(true);
  expect(peak).toBe(50);
  expect(assess).not.toHaveBeenCalled();
  await workspaceService.shutdown();
}, 30_000);

test("resume writing reuses the complete listing without forcing another full fit assessment", async () => {
  const seed = fixture(1);
  seed.savedJobs[0] = {
    ...seed.savedJobs[0]!,
    detailQuality: "detail_enriched",
    listingDetailFetch: {
      attemptedAt: "2026-10-13T00:00:00.000Z",
      outcome: "enriched",
      method: "page_text",
      detail: "Complete saved listing",
    },
  };
  const aiClient = createAiClient();
  const assess = vi.spyOn(aiClient, "assessJobFit");
  const fetchListingHtml = vi.fn((url: string) =>
    Promise.resolve({
      status: 200,
      finalUrl: url,
      html: "<article>Already captured</article>",
    }),
  );
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    fetchListingHtml,
  });
  const receipt = await workspaceService.generateResumeForBatch("pipeline_0", {
    shouldStop: () => false,
  });
  expect(receipt.outcome).toMatch(/written|fallback/);
  expect(assess).not.toHaveBeenCalled();
  expect(fetchListingHtml).not.toHaveBeenCalled();
  await workspaceService.shutdown();
});

test("a provider 402 pauses all waiting writers before permit handoff and keeps the full queue", async () => {
  const seed = fixture(200);
  let stop = false;
  let calls = 0;
  let rejectAll!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    rejectAll = resolve;
  });
  const aiClient = createAiClient();
  const failing = createOpenAiCompatibleJobFinderAiClient({
    apiKey: "synthetic",
    baseUrl: "https://example.test/v1",
    model: "synthetic",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => {
      calls++;
      await responseGate;
      return new Response(
        JSON.stringify({ error: { message: "Insufficient account funds" } }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    });
  aiClient.createResumeDraft = (input) => failing.createResumeDraft(input);
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  const onProviderBlocked = vi.fn(() => {
    stop = true;
  });
  const receipts = seed.savedJobs.map((job) =>
    workspaceService.generateResumeForBatch(job.id, {
      shouldStop: () => stop,
      onProviderBlocked,
    }),
  );
  try {
    await vi.waitFor(() => expect(calls).toBe(50));
    rejectAll();
    const results = await Promise.all(receipts);
    expect(calls).toBe(50);
    expect(
      results.filter((result) => result.outcome === "blocked"),
    ).toHaveLength(50);
    expect(
      results.filter((result) => result.outcome === "not_started"),
    ).toHaveLength(150);
    expect(
      results.filter((result) => result.outcome === "written"),
    ).toHaveLength(0);
    expect(onProviderBlocked).toHaveBeenCalledTimes(50);
    expect(
      results.find((result) => result.outcome === "blocked")?.providerBlock
        ?.reason,
    ).toBe("funding");
    expect(await repository.listResumeDrafts()).toHaveLength(0);
    expect(await repository.listSavedJobs()).toHaveLength(200);
  } finally {
    rejectAll();
    await Promise.allSettled(receipts);
    fetchMock.mockRestore();
    await workspaceService.shutdown();
  }
}, 30_000);

test("a listing read the AI service refuses pauses the writer instead of saving an untailored resume", async () => {
  const seed = fixture(3);
  seed.savedJobs = seed.savedJobs.map((job) => ({
    ...job,
    description: job.title,
    summary: null,
    keySkills: [],
    detailQuality: "card_only",
    listingDetailFetch: null,
  }));
  const aiClient = createAiClient();
  const failing = createOpenAiCompatibleJobFinderAiClient({
    apiKey: "synthetic",
    baseUrl: "https://example.test/v1",
    model: "synthetic",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "Insufficient account funds" } }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  aiClient.extractJobsFromPage = (input) => failing.extractJobsFromPage(input);
  const createResumeDraft = vi.spyOn(aiClient, "createResumeDraft");
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    fetchListingHtml: (url) =>
      Promise.resolve({
        status: 200,
        finalUrl: url,
        html: "<main><h1>Senior frontend engineer</h1><p>Build accessible React interfaces with TypeScript for a product team, own state management and collaborate on design systems.</p></main>",
      }),
  });
  try {
    const receipt = await workspaceService.generateResumeForBatch(
      "pipeline_0",
      { shouldStop: () => false },
    );
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.providerBlock?.reason).toBe("funding");
    expect(createResumeDraft).not.toHaveBeenCalled();
    expect(await repository.listResumeDrafts()).toHaveLength(0);
    expect(
      (await repository.listTailoredAssets()).filter(
        (asset) => asset.status === "ready",
      ),
    ).toHaveLength(0);
  } finally {
    fetchMock.mockRestore();
    await workspaceService.shutdown();
  }
}, 30_000);
