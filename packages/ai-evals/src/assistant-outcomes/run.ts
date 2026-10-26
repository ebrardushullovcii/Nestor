import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";
import type {
  ApplicationStoreDemoResult,
  DesktopJobsBridge,
  DesktopProfileWorkflowBridge,
} from "@nestor/contracts";
import { ACTION_INVENTORY } from "./inventory";
import { runBuiltAppOutcomes, type BuiltAppBatch } from "./built-app";
import { navigationOutcomeCases, shellOutcomeCases } from "./view-cases";
import {
  profileFieldOutcomeCases,
  profileRecordOutcomeCases,
} from "./profile-cases";
import {
  preferenceOutcomeCases,
  checkPreferenceFixtures,
} from "./preference-cases";
import { siteOutcomeCases } from "./site-cases";
import { trackerOutcomeCases } from "./tracker-cases";
import { applicationViewOutcomeCases } from "./application-view-cases";
import { readOutcomeCases } from "./read-cases";

interface VerifyContext {
  page: Promise<Page>;
  app: ElectronApplication;
  ai: string;
  checkout: string;
  evidenceDir: string;
  userDataDir: string;
  sites: { url: string };
  shot(name: string): Promise<unknown>;
  note(text: string): Promise<unknown>;
}
export function allBatches(
  replicaOrigin = "http://127.0.0.1:1",
): BuiltAppBatch[] {
  checkPreferenceFixtures();
  return [
    ...navigationOutcomeCases(),
    ...shellOutcomeCases(),
    ...readOutcomeCases(),
    ...profileFieldOutcomeCases(),
    ...profileRecordOutcomeCases(),
    ...preferenceOutcomeCases(),
    ...siteOutcomeCases(replicaOrigin),
    ...applicationViewOutcomeCases(),
    ...trackerOutcomeCases(),
  ];
}

export function selectBatches(
  batches: readonly BuiltAppBatch[],
  prefixes: readonly string[],
): BuiltAppBatch[] {
  if (!prefixes.length) return [...batches];
  const byId = new Map(batches.map((batch) => [batch.id, batch]));
  const chosen = new Set<string>();
  function include(batch: BuiltAppBatch, stack: readonly string[] = []) {
    if (stack.includes(batch.id))
      throw Error(`Cyclic prerequisites: ${[...stack, batch.id].join(" -> ")}`);
    for (const id of batch.requires ?? []) {
      const dependency = byId.get(id);
      if (!dependency) throw Error(`Missing prerequisite ${id}`);
      include(dependency, [...stack, batch.id]);
    }
    chosen.add(batch.id);
  }
  for (const prefix of prefixes) {
    const matches = batches.filter((batch) =>
      batch.actions.some((action) => action.actionId.startsWith(prefix)),
    );
    if (!matches.length)
      throw Error(
        `No implemented case matches ${prefix}; use --list for the full map`,
      );
    matches.forEach((batch) => include(batch));
  }
  return batches.filter((batch) => chosen.has(batch.id));
}

export function list() {
  const batches = allBatches();
  const covered = new Set(
    batches.flatMap((batch) => batch.actions.map((action) => action.actionId)),
  );
  console.log(
    JSON.stringify(
      {
        controls: ACTION_INVENTORY.length,
        implementedCases: covered.size,
        batches: batches.length,
        actions: ACTION_INVENTORY.map((entry) => ({
          ...entry,
          caseImplemented: covered.has(entry.id),
        })),
      },
      null,
      2,
    ),
  );
}

export async function run(
  ctx: VerifyContext,
  options: { label: string; prefixes?: string[] },
) {
  if (ctx.ai !== "live")
    throw Error(
      "Outcome runs require the live Assistant, not the scripted reachability model",
    );
  if (
    !new URL(ctx.sites.url).hostname.match(
      /^(?:127\.0\.0\.1|localhost|\[::1\])$/u,
    )
  )
    throw Error(
      "The outcome eval requires this instance's loopback replica sites",
    );
  if (!path.basename(ctx.userDataDir).startsWith("nestor-verify-"))
    throw Error(
      "Refusing to seed anything except an isolated verify-nestor data folder",
    );
  const batches = selectBatches(
    allBatches(ctx.sites.url),
    options.prefixes ?? [],
  );
  const state = JSON.parse(
    await readFile(
      path.join(
        process.env.NESTOR_VERIFY_WORK!,
        ".verify-state",
        options.label,
        "state.json",
      ),
      "utf8",
    ),
  ) as {
    net: string;
    guard: string;
    build: { head: string; dirty: string | null };
  };
  if (state.net !== "replica" || state.guard !== "verified")
    throw Error("Replica network guard did not pass");
  const page = await ctx.page;
  page.setDefaultTimeout(10_000);
  // Preconditions only. The actual requests below go through the visible composer.
  await page.evaluate(
    async (origin) => {
      const bridge = (
        window as unknown as {
          nestor: {
            jobs: DesktopJobsBridge;
            profileWorkflow: DesktopProfileWorkflowBridge;
            jobFinder: {
              test: {
                loadApplicationsStoreDemo(input: {
                  sourceUrl: string;
                  trackApplications: boolean;
                }): Promise<ApplicationStoreDemoResult>;
              };
            };
          };
        }
      ).nestor;
      await bridge.jobs.run("patch_profile", {
        fields: {
          firstName: "Alex",
          lastName: "Synthetic",
          fullName: "Alex Synthetic",
          email: "alex@example.test",
          headline: "Synthetic software engineer",
          currentLocation: "Budapest, Hungary",
          currentCountry: "Hungary",
          timeZone: "Europe/Budapest",
          "workEligibility.requiresVisaSponsorship": false,
        },
        lists: {
          skills: ["TypeScript"],
          "workEligibility.authorizedWorkCountries": ["Hungary"],
        },
      });
      await bridge.jobs.run("patch_profile_goals", {
        lists: {
          targetRoles: ["Software Engineer"],
          locations: ["Remote"],
          workModes: ["remote"],
        },
      });
      await bridge.jobs.run("add_sites", { text: origin + "/board/" });
      const setup = await bridge.profileWorkflow.run({ type: "read" });
      await bridge.profileWorkflow.run({
        type: "save_setup_state",
        state: {
          ...setup.state.profileSetupState,
          status: "completed",
          currentStep: "targeting",
          completedAt: new Date().toISOString(),
          reviewItems: [],
        },
      });
      await bridge.jobFinder.test.loadApplicationsStoreDemo({
        sourceUrl: origin + "/board/",
        trackApplications: true,
      });
    },
    ctx.sites.url.replace(/\/$/u, ""),
  );
  // Re-read launch context after seeding, rather than leaving the first-run
  // shell on its cached Guided setup destination.
  await page.reload();
  await page.locator("[data-job-finder-shell]").waitFor();
  const synthetic = await page.evaluate(() =>
    (
      window as unknown as { nestor: { jobs: DesktopJobsBridge } }
    ).nestor.jobs.run("get_profile", {}),
  );
  if (!String(synthetic.fields.email ?? "").includes("@"))
    throw Error("Synthetic Profile did not hydrate");
  await page.evaluate(async () => {
    const jobs = (window as unknown as { nestor: { jobs: DesktopJobsBridge } })
      .nestor.jobs;
    await jobs.run("upsert_profile_record", {
      collection: "links",
      record: {
        id: "Before",
        label: "Initial synthetic portfolio",
        url: "https://example.test/before",
        kind: "portfolio",
        isDraft: false,
      },
    });
    await jobs.run("upsert_profile_record", {
      collection: "projects",
      record: {
        id: "outcome-proof-project",
        name: "Synthetic reference project",
      },
    });
    await jobs.run("patch_settings", {
      fields: {
        collapseSideMenuWithAssistant: false,
        applicationAutomationMode: "confirm_before_submit",
      },
    });
  });
  await writeFile(
    path.join(ctx.evidenceDir, "case-selection.json"),
    JSON.stringify(
      {
        requestedPrefixes: options.prefixes ?? [],
        selectedBatches: batches.map((batch) => batch.id),
        inventoryTotal: ACTION_INVENTORY.length,
        setup:
          "Synthetic demo profile and replica job seeded; user actions are requested through chat",
      },
      null,
      2,
    ),
  );
  const report = await runBuiltAppOutcomes({
    page,
    evidenceDir: ctx.evidenceDir,
    environment: {
      buildCommit: state.build.head,
      buildChangesHash: state.build.dirty,
      label: options.label,
      ai: "live",
      net: "replica",
      doctorPassed: true,
    },
    batches,
    shot: (name) => ctx.shot(name),
    note: (text) => ctx.note(text),
  });
  const lines = [
    `Assistant outcomes: ${state.build.head}`,
    `${report.inventoryTotal} controls, ${report.excluded.length} explicit exclusions.`,
    `Completed ${report.counts.completed}; correctly blocked ${report.counts.correctly_blocked}; unsupported ${report.counts.unsupported}; failed ${report.counts.failed}.`,
    "",
    ...report.actions.map(
      (action) =>
        `${action.outcome}: ${action.id} — ${action.action}${action.cases.flatMap((item) => item.failures).length ? " — " + action.cases.flatMap((item) => item.failures).join("; ") : ""}`,
    ),
    "",
    "Excluded controls (included in inventoryTotal):",
    ...report.excluded.map(
      (item) => `${item.id}: ${item.action} — ${item.reason}`,
    ),
  ];
  await writeFile(
    path.join(ctx.evidenceDir, "assistant-outcomes.txt"),
    lines.join("\n") + "\n",
  );
  return report;
}
