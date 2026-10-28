import type { AssistantContextReference } from "@nestor/contracts";

import type { AssistantLaneCase, AssistantLaneObservation } from "./cases";
import { laneContext } from "./world";

/**
 * When the sidebar opens a screen and when it only answers. The rule:
 *
 * - Open a screen when the person asks to see, open, go to, pull up or look
 *   at something, names a screen as a destination, asks where to change
 *   something, asks what was sent, or says "open it" about a record just
 *   discussed.
 * - Answer only for questions: counts, values, yes/no, status, lists,
 *   how-to, why and advice. The text answer is enough; they can ask to open.
 * - Never open the screen already showing the answer, and never leave
 *   Profile while it has unsaved typing unless they asked to go.
 * - Always answer in text, navigation or not.
 *
 * Lane job ids map to store ids in order: Northwind 1, Bluebird 2, Quartz 3,
 * Harbor 4, Cinder 5.
 */

const screen = (
  name: AssistantContextReference["screen"],
  route: string,
  overrides: Partial<AssistantContextReference> = {},
) => laneContext({ screen: name, route, ...overrides });

const HOME = screen("home", "/job-finder/home");
const FIND_JOBS = screen("discovery", "/job-finder/discovery", {
  list: {
    listKind: "jobs",
    selectedIds: [],
    displayedIds: ["4", "5"],
    filteredIds: ["4", "5"],
    totalFilteredCount: 2,
    filterSummary: null,
    campaignId: null,
  },
});
const SHORTLISTED = screen("review_queue", "/job-finder/review-queue", {
  list: {
    listKind: "shortlist",
    selectedIds: [],
    displayedIds: ["2", "3"],
    filteredIds: ["2", "3"],
    totalFilteredCount: 2,
    filterSummary: null,
    campaignId: null,
  },
});
const SETTINGS = screen("settings", "/job-finder/settings");
const profile = (section: string, dirtyFields: string[] = []) =>
  screen("profile", `/job-finder/profile?section=${section}`, {
    sectionLabel: section,
    editor: {
      editor: "profile",
      savedRevision: null,
      draftVersion: dirtyFields.length,
      dirtyFields,
      unsavedValues: dirtyFields.includes("headline")
        ? { headline: "Lead product designer, design systems" }
        : {},
      section,
      selection: null,
    },
  });

interface Destination {
  path: string;
  params?: Record<string, string>;
  /** Accept any of these paths instead of `path`. */
  or?: readonly string[];
}

function matches(route: string, destination: Destination): boolean {
  const url = new URL(route, "https://nestor.local");
  const paths = [destination.path, ...(destination.or ?? [])];
  return (
    paths.includes(url.pathname) &&
    Object.entries(destination.params ?? {}).every(
      ([key, value]) => url.searchParams.get(key) === value,
    )
  );
}

const describeRoute = (destination: Destination) =>
  `${destination.path}${destination.params ? `?${new URLSearchParams(destination.params).toString()}` : ""}`;

/** Opened the destination last and answered in text with the fact. */
function opens(destination: Destination, fact: RegExp) {
  return (o: AssistantLaneObservation): string[] => {
    const last = o.navigations.at(-1);
    return [
      ...(last
        ? matches(last, destination)
          ? []
          : [`opened ${last}, expected ${describeRoute(destination)}`]
        : [`did not open ${describeRoute(destination)}`]),
      ...(fact.test(o.replyText) ? [] : [`reply lacks ${String(fact)}`]),
      ...(o.changes.length === 0 ? [] : ["something was changed"]),
    ];
  };
}

/** Stayed on the current screen and answered in text with the fact. */
function answers(fact: RegExp) {
  return (o: AssistantLaneObservation): string[] => [
    ...(o.navigations.length === 0
      ? []
      : [`opened ${o.navigations.join(", ")} without being asked`]),
    ...(fact.test(o.replyText) ? [] : [`reply lacks ${String(fact)}`]),
    ...(o.changes.length === 0 ? [] : ["something was changed"]),
  ];
}

const navCase = (
  id: string,
  title: string,
  turns: AssistantLaneCase["turns"],
  check: AssistantLaneCase["check"],
): AssistantLaneCase => ({
  id: `nav.${id}`,
  title,
  inventory: [],
  scripted: false,
  scenario: "navigation",
  turns,
  check,
});

const SHORTLIST_NAMES = /bluebird[\s\S]*quartz|quartz[\s\S]*bluebird/iu;
const NOTHING_WAITING =
  /\bno\b|none|nothing|not (?:any|waiting)|all clear|don't have any|aren't any/iu;

export const NAVIGATION_CASES: AssistantLaneCase[] = [
  // Asked to see a screen or record: open it and answer.
  navCase(
    "go.shortlisted",
    "Show me my shortlisted jobs",
    [{ text: "Show me my shortlisted jobs", context: HOME }],
    opens({ path: "/job-finder/review-queue" }, SHORTLIST_NAMES),
  ),
  navCase(
    "go.settings",
    "Open settings",
    [{ text: "Open settings", context: HOME }],
    opens({ path: "/job-finder/settings" }, /settings/iu),
  ),
  navCase(
    "go.needs_you",
    "Take me to Needs you",
    [{ text: "Take me to Needs you", context: HOME }],
    opens({ path: "/job-finder/actions" }, /needs you/iu),
  ),
  navCase(
    "go.resume_edit",
    "Open the Bluebird resume so I can edit it",
    [{ text: "Open the Bluebird resume so I can edit it", context: HOME }],
    opens(
      { path: "/job-finder/review-queue", params: { jobId: "2" } },
      /bluebird/iu,
    ),
  ),
  navCase(
    "go.applications_board",
    "Show my applications board",
    [{ text: "Show my applications board", context: HOME }],
    opens({ path: "/job-finder/applications" }, /northwind/iu),
  ),
  navCase(
    "go.pull_up_resume",
    "Can you pull up my resume?",
    [{ text: "can you pull up my resume?", context: HOME }],
    opens(
      { path: "/job-finder/profile", or: ["/job-finder/review-queue"] },
      /resume|riley-okafor/iu,
    ),
  ),
  navCase(
    "go.todays_jobs",
    "Let me look at today's new jobs",
    [{ text: "Let me look at today's new jobs", context: HOME }],
    opens({ path: "/job-finder/discovery" }, /harbor|cinder|job/iu),
  ),
  navCase(
    "go.review_named_job",
    "I want to review the Quartz Freight job",
    [{ text: "I want to review the Quartz Freight job", context: HOME }],
    opens(
      { path: "/job-finder/review-queue", params: { jobId: "3" } },
      /quartz/iu,
    ),
  ),
  navCase(
    "go.what_sent",
    "What did I send to Northwind?",
    [{ text: "What did I send to Northwind?", context: HOME }],
    opens(
      { path: "/job-finder/applications", params: { jobId: "1" } },
      /northwind/iu,
    ),
  ),
  navCase(
    "go.where_resume_level",
    "Where do I change my resume level?",
    [{ text: "Where do I change my resume level?", context: HOME }],
    opens(
      { path: "/job-finder/profile", params: { section: "preferences" } },
      /preferences/iu,
    ),
  ),
  navCase(
    "go.follow_up_that_one",
    '"Show me that one" opens the job just discussed',
    [
      { text: "Tell me about the Harbor Mutual job.", context: FIND_JOBS },
      { text: "show me that one", context: FIND_JOBS },
    ],
    opens({ path: "/job-finder/discovery", params: { job: "4" } }, /harbor/iu),
  ),
  navCase(
    "go.follow_up_open_it",
    '"Open it" after a question opens the setting just discussed',
    [
      { text: "What's my default resume level?", context: HOME },
      { text: "Open it", context: HOME },
    ],
    opens(
      { path: "/job-finder/profile", params: { section: "preferences" } },
      /tailored/iu,
    ),
  ),
  navCase(
    "go.unsaved_within_profile",
    "Opening another Profile tab keeps unsaved typing, so it may open",
    [
      {
        text: "Where do I set which job sites to search?",
        context: profile("basics", ["headline"]),
      },
    ],
    opens(
      { path: "/job-finder/profile", params: { section: "sources" } },
      /job sources/iu,
    ),
  ),

  // Questions: answer in text and stay put.
  navCase(
    "ask.shortlist_count",
    "How many jobs are shortlisted?",
    [{ text: "How many jobs are shortlisted?", context: HOME }],
    answers(/\b(?:2|two)\b/iu),
  ),
  navCase(
    "ask.headline",
    "What's my headline?",
    [{ text: "What's my headline?", context: HOME }],
    answers(/product designer/iu),
  ),
  navCase(
    "ask.remote",
    "Is the Northwind job remote?",
    [{ text: "Is the Northwind job remote?", context: FIND_JOBS }],
    answers(/remote/iu),
  ),
  navCase(
    "ask.fill_in_meaning",
    "What does Fill in for me mean?",
    [{ text: "What does Fill in for me mean?", context: HOME }],
    answers(/fill/iu),
  ),
  navCase(
    "ask.resume_level_read_only",
    "Don't change anything: what's my default resume level?",
    [
      {
        text: "Don't change anything — what's my default resume level?",
        context: HOME,
      },
    ],
    answers(/tailored/iu),
  ),
  navCase(
    "ask.whats_on_shortlist",
    "What's on my shortlist?",
    [{ text: "What's on my shortlist?", context: HOME }],
    answers(SHORTLIST_NAMES),
  ),
  navCase(
    "ask.applications_need_me",
    "Which applications need me?",
    [{ text: "Which applications need me?", context: HOME }],
    answers(NOTHING_WAITING),
  ),
  navCase(
    "ask.why_score",
    "Why did the Bluebird job score low?",
    [{ text: "Why did the Bluebird job score low?", context: FIND_JOBS }],
    answers(/88/u),
  ),
  navCase(
    "ask.application_status",
    "How's my Northwind application going?",
    [{ text: "How's my Northwind application going?", context: HOME }],
    answers(/applied|sent|submitted/iu),
  ),
  navCase(
    "ask.questions_waiting",
    "Any questions waiting for me?",
    [{ text: "Any questions waiting for me?", context: HOME }],
    answers(NOTHING_WAITING),
  ),
  navCase(
    "ask.resume_look",
    "What's my resume look setting?",
    [{ text: "what's my resume look setting?", context: HOME }],
    answers(/classic|ats/iu),
  ),
  navCase(
    "ask.list_sources",
    "List my sources",
    [{ text: "list my sources", context: HOME }],
    answers(NOTHING_WAITING),
  ),
  navCase(
    "ask.how_to_add_source",
    "How do I add a job source?",
    [{ text: "How do I add a job source?", context: HOME }],
    answers(/job sources/iu),
  ),
  navCase(
    "ask.send_mode_on_settings",
    "Is Send for me on? (asked on Settings)",
    [{ text: "Is Send for me turned on?", context: SETTINGS }],
    answers(/\bno\b|not|off|ask|confirm/iu),
  ),

  // Already looking at it, or unsaved typing: stay.
  navCase(
    "stay.already_on_shortlisted",
    "Show my shortlisted jobs, asked on Shortlisted",
    [{ text: "show my shortlisted jobs", context: SHORTLISTED }],
    answers(SHORTLIST_NAMES),
  ),
  navCase(
    "stay.headline_on_profile",
    "Where's my headline?, asked on Profile > Basics",
    [{ text: "Where's my headline?", context: profile("basics") }],
    answers(/basics|headline/iu),
  ),
  navCase(
    "stay.unsaved_question",
    "A question while Profile has unsaved typing",
    [
      {
        text: "What are my target roles?",
        context: profile("basics", ["headline"]),
      },
    ],
    answers(/product designer/iu),
  ),
  navCase(
    "stay.unsaved_where_elsewhere",
    "Where do I change my resume look?, asked with unsaved Profile typing",
    [
      {
        text: "Where do I change my resume look?",
        context: profile("basics", ["headline"]),
      },
    ],
    (o) => [
      ...answers(/settings/iu)(o),
      ...(/unsaved|not saved|save/iu.test(o.replyText)
        ? []
        : ["reply does not mention the unsaved Profile typing"]),
    ],
  ),
];
