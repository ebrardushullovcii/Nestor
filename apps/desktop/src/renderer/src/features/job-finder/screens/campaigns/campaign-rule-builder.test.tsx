// @vitest-environment jsdom

import {
  CampaignRuleSchema,
  CampaignRuleFunnelProjectionSchema,
  type CampaignRuleFunnelProjection,
  type JobSearchCampaign,
  type SaveCampaignRuleInput,
} from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetJobFinderOverlaysForTests } from "../../lib/job-finder-overlay-ownership";
import { CampaignRuleBuilder } from "./campaign-rule-builder";

afterEach(() => {
  cleanup();
  resetJobFinderOverlaysForTests();
  // Every production rule-builder flow must resolve destructive decisions
  // in-app; the native confirm stays uncalled for the whole suite.
  expect(confirmNeverSpy).not.toHaveBeenCalled();
});

const confirmNeverSpy = vi
  .spyOn(window, "confirm")
  .mockImplementation(() => false);

const recordedAt = "2026-08-15T10:00:00.000Z";
const measuredAt = "2026-08-15T12:00:00.000Z";

function createRule(input: {
  id: string;
  kind: "must_have" | "prefer" | "never";
  field: string;
  operator: string;
  value: string;
  enabled?: boolean;
  effect?: unknown;
}) {
  return CampaignRuleSchema.parse({
    id: input.id,
    kind: input.kind,
    field: input.field,
    operator: input.operator,
    value: input.value,
    enabled: input.enabled ?? true,
    provenance: { source: "user", recordedAt },
    effect: input.effect,
  });
}

function createCampaign(
  rules: ReturnType<typeof createRule>[] = [],
): JobSearchCampaign {
  return {
    id: "campaign_1",
    name: "Remote TypeScript",
    description: "Focused scope",
    mode: "precision",
    status: "active",
    sourceTargetIds: ["source-1"],
    jobIds: ["job_1", "job_2"],
    minimumFitScore: 70,
    searchPreferences: {
      targetRoles: ["Software Engineer"],
      jobFamilies: [],
      locations: ["Worldwide remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: 2_000,
        maximum: 4_000,
        interval: "month",
        currency: "EUR",
        currencyStatus: "explicit",
      },
      approvalMode: "manual",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [],
      },
    },
    limits: {
      retainedJobTarget: 15,
      analysisConcurrency: 2,
      preparationBatchSize: 5,
      dailyPreparationLimit: 20,
    },
    stopRules: {
      pauseOnLoginRequired: false,
      pauseOnChangedForm: true,
      pauseOnUncertainEligibility: true,
      pauseOnFailureRatePercent: 30,
      failureRateMinimumSample: 5,
    },
    applicationPolicy: {
      resumeStrategy: "job_specific",
      requireReviewBeforePreparation: true,
      requireReviewBeforeExternalWrite: true,
      finalSubmitAuthorized: false,
    },
    schedule: {
      enabled: false,
      daysOfWeek: [],
      localStartTime: null,
      timeZone: null,
    },
    progress: {
      jobsFound: 10,
      jobsRetained: 3,
      applicationsPrepared: 1,
      applicationsApplied: 0,
      currentBatchCompleted: 0,
      currentBatchTotal: 0,
      blockedCount: 0,
      remainingQueueSize: 2,
      lastRunAt: null,
      lastUpdatedAt: "2026-08-15T09:00:00.000Z",
    },
    history: [],
    createdAt: "2026-08-15T09:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    rules,
  } as unknown as JobSearchCampaign;
}

function createProjection(
  overrides: Partial<CampaignRuleFunnelProjection> = {},
): CampaignRuleFunnelProjection {
  return CampaignRuleFunnelProjectionSchema.parse({
    campaignId: "campaign_1",
    generatedAt: measuredAt,
    rules: [
      createRule({
        id: "rule_frontend",
        kind: "must_have",
        field: "role",
        operator: "contains",
        value: "frontend",
        effect: {
          sampleSize: 2,
          removedCount: 1,
          downgradedCount: 0,
          unknownCount: 0,
          measuredAt,
        },
      }),
    ],
    disabledRuleIds: ["rule_never_acme"],
    funnel: {
      sampleSize: 2,
      hardRemovedCount: 1,
      retainedCount: 1,
      preferDowngradedCount: 0,
      uncertainCount: 0,
      confirmedRetainedCount: 1,
      rankedJobIds: ["job_2"],
      measuredAt,
    },
    ...overrides,
  });
}

function renderBuilder(props: {
  campaign?: JobSearchCampaign;
  projection?: CampaignRuleFunnelProjection | null;
  onSaveRule?: (rule: SaveCampaignRuleInput) => void;
  onClose?: () => void;
  onDeleteRule?: (ruleId: string) => void;
  onToggleRule?: (ruleId: string, enabled: boolean) => void;
}) {
  return render(
    <CampaignRuleBuilder
      campaign={props.campaign ?? createCampaign()}
      onClose={props.onClose ?? vi.fn()}
      onDeleteRule={props.onDeleteRule ?? vi.fn()}
      onSaveRule={props.onSaveRule ?? vi.fn()}
      onToggleRule={props.onToggleRule ?? vi.fn()}
      pending={false}
      projection={props.projection ?? null}
    />,
  );
}

describe("CampaignRuleBuilder", () => {
  it("shows rules grouped by kind with provenance and measured counts", () => {
    const rules = [
      createRule({
        id: "rule_frontend",
        kind: "must_have",
        field: "role",
        operator: "contains",
        value: "frontend",
        effect: {
          sampleSize: 2,
          removedCount: 1,
          downgradedCount: 0,
          unknownCount: 0,
          measuredAt,
        },
      }),
      createRule({
        id: "rule_never_acme",
        kind: "never",
        field: "company",
        operator: "equals",
        value: "Acme Corp",
        enabled: false,
      }),
      createRule({
        id: "rule_prefer_remote",
        kind: "prefer",
        field: "work_mode",
        operator: "equals",
        value: "remote",
      }),
    ];
    renderBuilder({
      campaign: createCampaign(rules),
      projection: createProjection(),
    });

    expect(screen.getByText("Must have · 1")).toBeTruthy();
    expect(screen.getByText("Prefer · 1")).toBeTruthy();
    expect(screen.getByText("Never · 1")).toBeTruthy();
    expect(screen.getByText("Role contains frontend")).toBeTruthy();
    expect(screen.getByText(/1 removed/)).toBeTruthy();
    expect(screen.getAllByText(/Source: You/)).toHaveLength(3);
    // Disabled rules are labeled and never reported as measured.
    expect(screen.getByText("Disabled — not measured")).toBeTruthy();
  });

  it("says plainly that nothing has been kept yet, in search-plan words", () => {
    const zeroed = createProjection({
      rules: [],
      disabledRuleIds: [],
      funnel: {
        sampleSize: 0,
        hardRemovedCount: 0,
        retainedCount: 0,
        preferDowngradedCount: 0,
        uncertainCount: 0,
        confirmedRetainedCount: 0,
        rankedJobIds: [],
        measuredAt,
      },
    });
    renderBuilder({ projection: zeroed });
    expect(
      screen.getByText(/This search plan has not kept any jobs yet/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Hard removed/)).toBeNull();
    // No engineering vocabulary left on the block a person reads first.
    expect(document.body.textContent).not.toMatch(/funnel/i);
    expect(document.body.textContent).not.toMatch(/campaign/i);
  });

  it("searches rules by field, value, or kind and shows a no-match state", () => {
    const rules = [
      createRule({
        id: "rule_frontend",
        kind: "must_have",
        field: "role",
        operator: "contains",
        value: "frontend",
      }),
      createRule({
        id: "rule_never_acme",
        kind: "never",
        field: "company",
        operator: "equals",
        value: "Acme Corp",
      }),
    ];
    renderBuilder({ campaign: createCampaign(rules) });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules" }), {
      target: { value: "acme" },
    });
    expect(screen.getByText("Company equals Acme Corp")).toBeTruthy();
    expect(screen.queryByText("Role contains frontend")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules" }), {
      target: { value: "no such rule" },
    });
    expect(screen.getByText("No rules match your search.")).toBeTruthy();
  });

  it("ellipsizes the rule search hint on the input element and keeps it accessible", () => {
    renderBuilder({ projection: null });

    const search = screen.getByRole("searchbox", { name: "Search rules" });
    // The full scope stays in the DOM, the accessible name is unchanged, and
    // narrow widths fade the hint with an ellipsis instead of a hard clip.
    expect(search.getAttribute("placeholder")).toBe(
      "Search field, value, or kind",
    );
    expect(screen.getByLabelText("Search rules")).toBe(search);
    for (const className of [
      "text-ellipsis",
      "overflow-hidden",
      "whitespace-nowrap",
    ]) {
      expect(search.className).toContain(className);
    }
    // The retired ::placeholder-scoped utility cannot paint ellipsis in
    // Chromium; keep the shared input-level mechanism as the only one.
    expect(search.className).not.toContain("[&::placeholder]");
  });

  it("submits a new rule from the add form", () => {
    const onSaveRule = vi.fn<(rule: SaveCampaignRuleInput) => void>();
    renderBuilder({ onSaveRule });

    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "backend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(onSaveRule).toHaveBeenCalledTimes(1);
    const saved = onSaveRule.mock.calls[0]?.[0];
    expect(saved?.kind).toBe("must_have");
    expect(saved?.field).toBe("role");
    expect(saved?.operator).toBe("contains");
    expect(saved?.value).toBe("backend");
    expect(saved?.provenance.source).toBe("user");
  });

  it("submits the add form on Enter from the value field", () => {
    const onSaveRule = vi.fn<(rule: SaveCampaignRuleInput) => void>();
    renderBuilder({ onSaveRule });

    const valueInput = screen.getByLabelText("Value");
    fireEvent.change(valueInput, { target: { value: "Berlin" } });
    fireEvent.keyDown(valueInput, { key: "Enter" });
    fireEvent.submit(valueInput.closest("form")!);

    expect(onSaveRule).toHaveBeenCalledTimes(1);
    expect(onSaveRule.mock.calls[0]?.[0]?.value).toBe("Berlin");
  });

  it("shows field-level feedback and disables add for a nonnumeric travel value", () => {
    const onSaveRule = vi.fn<(rule: SaveCampaignRuleInput) => void>();
    renderBuilder({ onSaveRule });

    fireEvent.change(screen.getByLabelText("Job field"), {
      target: { value: "travel" },
    });
    const valueInput = screen.getByLabelText("Value (number)");
    fireEvent.change(valueInput, { target: { value: "not-a-number" } });

    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a valid non-negative number.",
    );
    expect(valueInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Add rule" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(onSaveRule).not.toHaveBeenCalled();
  });

  it("closes the builder on Escape", () => {
    const onClose = vi.fn();
    renderBuilder({ onClose });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("labels rule toggles with their rule description", () => {
    const rules = [
      createRule({
        id: "rule_frontend",
        kind: "must_have",
        field: "role",
        operator: "contains",
        value: "frontend",
      }),
      createRule({
        id: "rule_never_acme",
        kind: "never",
        field: "company",
        operator: "equals",
        value: "Acme Corp",
        enabled: false,
      }),
    ];
    renderBuilder({ campaign: createCampaign(rules) });

    const enabledToggle = screen.getByLabelText(
      "Toggle rule: Role contains frontend",
    );
    expect(enabledToggle.getAttribute("type")).toBe("checkbox");
    expect(enabledToggle.getAttribute("aria-label")).toBe(
      "Toggle rule: Role contains frontend",
    );
    expect(
      screen.getByLabelText("Toggle rule: Company equals Acme Corp"),
    ).toBeTruthy();
  });

  it("removes a rule only through the app-owned confirmation dialog", () => {
    const onDeleteRule = vi.fn<(ruleId: string) => void>();
    const onClose = vi.fn();
    renderBuilder({
      campaign: createCampaign([
        createRule({
          id: "rule_frontend",
          kind: "must_have",
          field: "role",
          operator: "contains",
          value: "frontend",
        }),
      ]),
      onDeleteRule,
      onClose,
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onDeleteRule).not.toHaveBeenCalled();
    expect(confirmNeverSpy).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog", {
      name: "Remove this rule?",
    });
    // The dialog names the exact rule, the affected plan, and the
    // consequence instead of a native prompt.
    expect(dialog.textContent).toContain("Role contains frontend");
    expect(dialog.textContent).toContain("Remote TypeScript");
    expect(dialog.textContent).toContain("This cannot be undone.");
    // Focus moves into the dialog, and staying owns the first (initially
    // focused) tab position as the safe default.
    expect(document.activeElement).toBe(dialog);
    expect(dialog.querySelector("button")?.textContent).toBe("Cancel");

    // Backdrop resolves to staying.
    fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onDeleteRule).not.toHaveBeenCalled();

    // Escape belongs to the dialog while open: it resolves to staying and
    // never closes the builder underneath in the same keypress.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDeleteRule).not.toHaveBeenCalled();

    // Explicit confirm removes exactly once and dismisses the dialog.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Remove rule",
      }),
    );
    expect(onDeleteRule).toHaveBeenCalledTimes(1);
    expect(onDeleteRule).toHaveBeenCalledWith("rule_frontend");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("styles rule builder selects with canonical tokens, focus hierarchy, and preserved geometry", () => {
    const { container } = renderBuilder({
      campaign: createCampaign([
        createRule({
          id: "rule_frontend",
          kind: "must_have",
          field: "role",
          operator: "contains",
          value: "frontend",
        }),
      ]),
    });

    const selects = Array.from(container.querySelectorAll("select"));
    // Kind, Job field, Operator.
    expect(selects).toHaveLength(3);

    for (const select of selects) {
      for (const className of [
        "border-(--field-border)",
        "bg-(--field)",
        "outline-none",
        "focus-visible:border-(--field-focus-border)",
        "focus-visible:bg-(--field-strong)",
        "focus-visible:shadow-[var(--field-focus-shadow)]",
      ]) {
        expect(select.className).toContain(className);
      }
      expect(select.className).not.toContain("border-input");
      expect(select.className).not.toContain("--surface-panel-raised");
      expect(select.className).not.toContain("focus-visible:ring");
      expect(select.className).toContain("h-11");
      expect(select.className).toContain("rounded-(--radius-field)");
      expect(select.className).toContain("px-3");
    }

    // Protected rule toggles stay bare native checkboxes without field
    // styling.
    const toggle = screen.getByLabelText("Toggle rule: Role contains frontend");
    expect(toggle.getAttribute("type")).toBe("checkbox");
    expect(toggle.className).not.toContain("field-");
    expect(toggle.className).not.toContain("focus-visible");

    // Native select behavior is unchanged: choosing a job field drives the
    // numeric-value affordance.
    fireEvent.change(screen.getByLabelText("Job field"), {
      target: { value: "travel" },
    });
    expect(screen.getByLabelText("Value (number)")).toBeTruthy();
  });
});

it("R3-219 starts a pay rule from EUR yearly profile minimum", () => {
  const campaign = createCampaign();
  campaign.searchPreferences.compensation = {
    minimum: 55000,
    maximum: null,
    interval: "year",
    currency: "EUR",
    currencyStatus: "explicit",
  };
  const onSaveRule = vi.fn();
  renderBuilder({ campaign, onSaveRule });
  fireEvent.change(screen.getByLabelText("Job field"), {
    target: { value: "compensation" },
  });
  expect(screen.getByLabelText("Currency")).toHaveProperty("value", "EUR");
  expect(screen.getByLabelText("Value (number)")).toHaveProperty(
    "value",
    "55000",
  );
  expect(screen.getByText(/Compare yearly pay/).textContent).toContain(
    "advertised minimum",
  );
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  expect(onSaveRule.mock.calls[0]?.[0]).toMatchObject({
    currency: "EUR",
    numericValue: 55000,
    operator: "greater_than_or_equal",
  });
});
