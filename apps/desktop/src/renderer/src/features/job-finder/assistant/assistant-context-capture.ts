import type {
  AssistantContextReference,
  AssistantEntityRef,
  AssistantScreen,
} from "@nestor/contracts";
import { ASSISTANT_SCREEN_LABELS } from "@nestor/contracts";

/**
 * What "this" means when a message is sent (plan §4). The renderer attaches
 * a typed reference; main resolves the ids through services and never reads
 * the app's DOM.
 */

export type AssistantContextPatch = Partial<
  Omit<AssistantContextReference, "capturedAt" | "mentions" | "attachments">
>;

export function screenForPathname(pathname: string): AssistantScreen {
  if (/\/job-finder\/review-queue\/[^/]+\/resume$/u.test(pathname))
    return "resume_studio";
  if (pathname.startsWith("/job-finder/profile/setup")) return "setup";
  const segment = pathname.replace(/^\/job-finder\/?/u, "").split("/")[0] ?? "";
  const screens: Record<string, AssistantScreen> = {
    "": "home",
    home: "home",
    profile: "profile",
    discovery: "discovery",
    "review-queue": "review_queue",
    applications: "applications",
    actions: "actions",
    settings: "settings",
  };
  return screens[segment] ?? "other";
}

const SCREEN_LABELS = ASSISTANT_SCREEN_LABELS;

export function describeScreen(screen: AssistantScreen): string {
  return SCREEN_LABELS[screen];
}

/** The record the URL points at (the same query keys the app's links use). */
export function focusFromLocation(
  pathname: string,
  search: string,
): AssistantEntityRef | null {
  const resume = /\/job-finder\/review-queue\/([^/]+)\/resume$/u.exec(pathname);
  if (resume?.[1]) {
    return { kind: "job", id: decodeURIComponent(resume[1]), label: null };
  }
  const params = new URLSearchParams(search);
  const applicationRecordId = params.get("applicationRecordId");
  if (applicationRecordId)
    return { kind: "application", id: applicationRecordId, label: null };
  const jobId = params.get(pathname === "/job-finder/discovery" ? "job" : "jobId");
  if (jobId) return { kind: "job", id: jobId, label: null };
  return null;
}

/**
 * Profile form paths in the profile's own field names, so the assistant can
 * tell which of its changes would touch an unsaved edit.
 */
export function profileFieldForEditorPath(path: string): string {
  const [root, second] = path.split(".");
  switch (root) {
    case "identity":
      return second === "summary" ? "summary" : (second ?? "identity");
    case "eligibility":
      return "workEligibility";
    case "languages":
      return "spokenLanguages";
    case "profileSkills":
      return "skills";
    case "records":
      return second ?? "records";
    case "summary":
      return "professionalSummary";
    case "minimumSalaryUsd":
    case "targetSalaryUsd":
    case "salaryCurrency":
    case "compensationInterval":
      return "compensation";
    case "collectOnlyHardCriteriaMatches":
    case "discoveryTargets":
      return "discovery";
    default:
      return root ?? path;
  }
}

/** Flattens react-hook-form dirty flags into field paths. */
export function flattenDirtyFields(value: unknown, prefix = ""): string[] {
  if (value === true) return prefix ? [prefix] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      flattenDirtyFields(entry, `${prefix}.${index}`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, entry]) =>
        flattenDirtyFields(entry, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [];
}

export function composeContextReference(input: {
  pathname: string;
  search: string;
  patches: readonly AssistantContextPatch[];
  browser: AssistantContextReference["browser"];
  selectedText: string | null;
  mentions: AssistantContextReference["mentions"];
  attachments: AssistantContextReference["attachments"];
  now: string;
}): AssistantContextReference {
  const base: AssistantContextReference = {
    screen: input.browser?.visible
      ? "browser"
      : screenForPathname(input.pathname),
    route: `${input.pathname}${input.search}`.slice(0, 400),
    sectionLabel: null,
    focus: focusFromLocation(input.pathname, input.search),
    list: null,
    editor: null,
    browser: input.browser,
    selectedText: input.selectedText
      ? input.selectedText.slice(0, 4_000)
      : null,
    mentions: input.mentions.slice(0, 20),
    attachments: input.attachments.slice(0, 5),
    capturedAt: input.now,
  };
  const merged = input.patches.reduce<AssistantContextReference>(
    (current, patch) => ({
      ...current,
      ...Object.fromEntries(
        Object.entries(patch).filter(
          ([, value]) => value !== undefined && value !== null,
        ),
      ),
    }),
    base,
  );
  // Text selected in the resume editor is the editor's selection too.
  const withSelection =
    merged.editor?.editor === "resume" && merged.selectedText
      ? {
          ...merged,
          editor: {
            ...merged.editor,
            selection: {
              sectionId: merged.editor.selection?.sectionId ?? null,
              entryId: merged.editor.selection?.entryId ?? null,
              bulletIds: merged.editor.selection?.bulletIds ?? [],
              text: merged.selectedText,
            },
          },
        }
      : merged;
  // The browser only takes over the screen while it is on screen.
  return input.browser?.visible
    ? { ...withSelection, screen: "browser" }
    : withSelection;
}

/**
 * A list as the person sees it. `checkedIds` are the rows they ticked (the
 * bulk selection); the row open in a detail pane is focus, never selection,
 * so "the ones I ticked" can only mean ticked rows.
 */
export function buildListContext(input: {
  listKind: NonNullable<AssistantContextReference["list"]>["listKind"];
  checkedIds: Iterable<string>;
  displayedIds: readonly string[];
  filteredIds: readonly string[];
  filterSummary?: string | null;
}): NonNullable<AssistantContextReference["list"]> {
  const filtered = new Set(input.filteredIds);
  const checked = [...input.checkedIds];
  return {
    listKind: input.listKind,
    // A ticked row hidden by a later filter is still ticked.
    selectedIds: [
      ...checked.filter((id) => filtered.has(id)),
      ...checked.filter((id) => !filtered.has(id)),
    ].slice(0, 500),
    displayedIds: input.displayedIds.slice(0, 300),
    filteredIds: input.filteredIds.slice(0, 3000),
    totalFilteredCount: input.filteredIds.length,
    filterSummary: input.filterSummary ?? null,
    campaignId: null,
  };
}
