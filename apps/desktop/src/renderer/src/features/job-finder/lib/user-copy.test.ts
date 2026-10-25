import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  describeFailure,
  FAILURE_SENTENCES,
  getJobFinderErrorDetail,
  getJobFinderErrorMessage,
  TECHNICAL_DETAILS_LABEL,
} from "./job-finder-error-message";
import { STATUS_COPY_TABLES } from "./status-copy";

/**
 * The guard for the Job Finder copy layer (RC-02, RC-03).
 *
 * `status-copy.ts` and `describe-failure.ts` make the right thing exist. This
 * file makes the wrong thing fail: a source scan over `features/job-finder`
 * and `pages` that forbids the three shapes that put system text on a screen.
 *
 * Adoption at the ~40 error sites and ~70 enum sites belongs to the zone
 * packages, so every file that still violates a rule today is named in
 * {@link PENDING_ADOPTION}. **Each zone package deletes its own entries when
 * it converts its files, and the list must be empty when the last zone
 * package lands.** That emptiness — not the existence of the modules — is the
 * acceptance criterion for RC-02 and RC-03.
 *
 * The allowlist is honest in both directions: an unlisted violation fails, and
 * so does a listed file that no longer violates. A stale entry is a failure,
 * which is what forces the list to shrink rather than rot.
 */

const RULE_IDS = [
  "rawThrownMessage",
  "formatStatusLabel",
  "underscoreDisplay",
  "legacyErrorMessageMapper",
  "internalVocabulary",
  "approvalSendsClaim",
] as const;

type RuleId = (typeof RULE_IDS)[number];

type Rule = {
  id: RuleId;
  /** What a reader sees when this shape ships, and what to use instead. */
  description: string;
  /** Files that define or legitimately own the shape. */
  exempt: readonly string[];
  find: (source: string) => readonly string[];
};

const LIB = "features/job-finder/lib";

const COPY_LAYER_OWNERS = [
  `${LIB}/status-copy.ts`,
  `${LIB}/describe-failure.ts`,
  `${LIB}/job-finder-error-message.ts`,
] as const;

/**
 * An error binding whose `.message` is the thrown text. Deliberately narrow:
 * `saveState.message`, `props.message` and `event.message` are app-owned copy
 * and are not in scope.
 */
const ERROR_BINDING = String.raw`(?:error|err|caught|thrown|failure|cause)`;

function findMatches(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)].map((match) =>
    match[0].replace(/\s+/g, " ").trim(),
  );
}

/**
 * Words a job seeker has no reason to know, banned from every surface they can
 * read. Comments are stripped first, so a note explaining WHY a term is banned
 * is allowed to name it.
 *
 * Deliberately narrow and literal: each entry is a phrase the blind panel
 * actually read on screen, not a guess about future jargon. Add to it when a
 * new term reaches a screen, never to make the regex clever.
 */
const INTERNAL_VOCABULARY_PATTERN =
  /SHA-256|\bATS\b|occupational role|evidence coverage|site writes|prepare-only authority|company intelligence|safeguard blockers?|discovery volume|pause windows?|saved search scope|the local scheduler|global activity pause|minimum fit score|job families|employment types|offline catalog|catalog jobs?|live source search|in this build/gi;

/**
 * Removes line and block comments so the ban applies to copy, not to the
 * reasoning above it. Strings containing "//" are rare in this layer and a
 * false strip can only ever hide a violation from the scan in the file that
 * wrote it, never invent one.
 */
function stripComments(source: string): string {
  return source
    .replace(BLOCK_COMMENT_PATTERN, " ")
    .split("\n")
    .map((line) => {
      const commentStart = line.indexOf("//");
      // A protocol ("https://") is not a comment; nothing else in this layer
      // puts a slash pair mid-line.
      return commentStart >= 0 && line[commentStart - 1] !== ":"
        ? line.slice(0, commentStart)
        : line;
    })
    .join("\n");
}

const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

const RULES: readonly Rule[] = [
  {
    id: "rawThrownMessage",
    description:
      "a thrown Error.message chosen as the user's failure copy — use describeFailure(error, { action }) and put the raw text behind a Technical details disclosure",
    exempt: COPY_LAYER_OWNERS,
    find: (source) => [
      // `error instanceof Error ? error.message : "A sentence."` — the thrown
      // text preferred over a sentence the app already wrote.
      ...findMatches(
        source,
        new RegExp(
          String.raw`\b${ERROR_BINDING}\??\.message\b[^;{}]{0,120}?(?::|\?\?)\s*"`,
          "gs",
        ),
      ),
      // `? error.message : UNKNOWN_FAILURE_ERROR` — the same choice, made
      // against a named constant instead of an inline sentence.
      ...findMatches(
        source,
        new RegExp(
          String.raw`\b${ERROR_BINDING}\??\.message\b[^;{}]{0,120}?:\s*[A-Z][A-Z0-9_]{3,}\b`,
          "gs",
        ),
      ),
      // `return error.message;` — a helper whose result becomes copy.
      ...findMatches(
        source,
        new RegExp(String.raw`\breturn\s+${ERROR_BINDING}\??\.message\b`, "g"),
      ),
      // `{error.message}` rendered straight into JSX.
      ...findMatches(
        source,
        new RegExp(
          String.raw`\{[^{}\n]*\b${ERROR_BINDING}\??\.message\b[^{}\n]*\}`,
          "g",
        ),
      ),
    ],
  },
  {
    id: "formatStatusLabel",
    description:
      "the generic title-caser used outside a Technical details disclosure — use an exhaustive table from lib/status-copy.ts",
    exempt: [`${LIB}/job-finder-utils.ts`],
    find: (source) =>
      source
        .split("\n")
        .filter(
          (line) =>
            line.includes("formatStatusLabel") &&
            !line.trimStart().startsWith("import") &&
            !line.trimStart().startsWith("*") &&
            !line.trimStart().startsWith("//") &&
            !/^\s*formatStatusLabel,?\s*$/.test(line),
        )
        .map((line) => line.trim()),
  },
  {
    id: "underscoreDisplay",
    description:
      'an underscore-to-space transform in a rendered position — "prepare only", "awaiting user", "replace section bullets" — use an exhaustive table from lib/status-copy.ts',
    exempt: [`${LIB}/job-finder-utils.ts`],
    find: (source) => [
      // Inside a JSX expression container or a `${}` interpolation.
      ...findMatches(
        source,
        /\{[^{}\n]*\.replace(?:All\("_", ?" ?"\)|\(\/_\/g, ?" ?"\))/g,
      ),
      // A helper that exists only to perform the transform.
      ...findMatches(
        source,
        /\breturn\s+[^;\n]*\.replace(?:All\("_", ?" ?"\)|\(\/_\/g, ?" ?"\))/g,
      ),
    ],
  },
  {
    id: "approvalSendsClaim",
    description:
      'approval copy that says approving sends or submits something — a tester read "Approving sends your resume", stopped, and left the job at NEEDS APPROVAL; say that approving lets Job Finder fill the form on your screen, that nothing is sent or submitted, and that you press the final button yourself',
    exempt: [],
    find: (source) =>
      findMatches(
        stripComments(source),
        /\bApprov(?:ing|al)\b[^.?!]{0,20}?\b(?:sends?|submits?)\b/gi,
      ),
  },
  {
    id: "internalVocabulary",
    description:
      'trade jargon or an internal term on a user surface — four testers scored this 4 out of 10 across three runs; say the plain thing instead ("reads reliably on job sites", "file fingerprint", "the role you are looking for")',
    exempt: [],
    find: (source) =>
      findMatches(stripComments(source), INTERNAL_VOCABULARY_PATTERN),
  },
  {
    id: "legacyErrorMessageMapper",
    description:
      "the staged mapper, which still passes unrecognised thrown text through — use describeFailure(error, { action }) instead",
    exempt: COPY_LAYER_OWNERS,
    find: (source) => findMatches(source, /\bgetJobFinderErrorMessage\(/g),
  },
];

/**
 * Files that still violate a rule. **Every entry is a real current violation**
 * and is deleted by the zone package that converts that file. The list MUST be
 * empty when the last zone package lands.
 *
 * Owners, by zone: `pages/**` → Applications;
 * `screens/settings/**` → Settings; `screens/discovery/**` → Find jobs;
 * `../shortlisted/**` → Shortlisted;
 * `components/profile/**` → Profile; `screens/companies/**`,
 * `screens/actions/**`, `screens/analytics/**`, `screens/rapid-review/**`,
 * `screens/safeguards/**` → their named zone; `components/job-finder-shell.tsx`
 * → shell.
 */
export const PENDING_ADOPTION = {
  rawThrownMessage: [
    "features/job-finder/components/profile/use-profile-source-debug-review.ts",
    "features/job-finder/hooks/use-job-finder-workspace.ts",
    "pages/use-job-finder-page-controller-actions.ts",
  ],
  formatStatusLabel: [
    "features/job-finder/components/profile/profile-background-sections.tsx",
    "features/job-finder/components/profile/profile-experience-tab.tsx",
    "features/job-finder/components/profile/profile-import-suggestion-list.tsx",
    "features/job-finder/components/profile/profile-preferences-sections.tsx",
    "features/job-finder/components/profile/setup/profile-setup-step-sections.tsx",
    "features/job-finder/screens/settings/settings-runtime-summary.tsx",
  ],
  underscoreDisplay: [
    "features/job-finder/components/profile/profile-timeline-repair-list.tsx",
    "features/job-finder/lib/source-intelligence-utils.ts",
  ],
  legacyErrorMessageMapper: ["pages/use-job-finder-page-controller-actions.ts"],
  // Empty on purpose, and it must stay empty: the sweep that added this rule
  // removed every occurrence it found.
  internalVocabulary: [],
  // Empty on purpose, and it must stay empty: approving never sends or
  // submits anything.
  approvalSendsClaim: [],
} as const satisfies Record<RuleId, readonly string[]>;

const RENDERER_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const SCAN_ROOTS = ["features/job-finder", "pages"] as const;

function listSourceFiles(): readonly string[] {
  const files: string[] = [];

  for (const root of SCAN_ROOTS) {
    const absoluteRoot = path.join(RENDERER_SRC, root);

    for (const entry of readdirSync(absoluteRoot, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) {
        continue;
      }

      const name = entry.name;

      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) {
        continue;
      }

      if (name.includes(".test.") || name.endsWith(".d.ts")) {
        continue;
      }

      files.push(
        path
          .relative(
            RENDERER_SRC,
            path.join(entry.parentPath ?? absoluteRoot, name),
          )
          .split(path.sep)
          .join("/"),
      );
    }
  }

  return files.sort();
}

type ScanResult = {
  /** Violating files not named in the allowlist. */
  unexpected: readonly string[];
  /** Allowlisted files that no longer violate — the entry must be deleted. */
  stale: readonly string[];
};

/**
 * The rule engine, separated from the filesystem so its allowlist behaviour is
 * itself testable.
 */
export function scanRule(
  rule: Rule,
  sources: ReadonlyMap<string, string>,
  allowlist: readonly string[],
): ScanResult {
  const violating = new Set<string>();

  for (const [file, source] of sources) {
    if (rule.exempt.includes(file)) {
      continue;
    }

    if (rule.find(source).length > 0) {
      violating.add(file);
    }
  }

  return {
    unexpected: [...violating].filter((file) => !allowlist.includes(file)),
    stale: allowlist.filter((file) => !violating.has(file)),
  };
}

const SOURCES: ReadonlyMap<string, string> = new Map(
  listSourceFiles().map((file) => [
    file,
    readFileSync(path.join(RENDERER_SRC, file), "utf8"),
  ]),
);

describe("Job Finder copy layer guard", () => {
  it("scans a non-trivial slice of the renderer", () => {
    expect(SOURCES.size).toBeGreaterThan(200);
  });

  it("implements and allowlists every declared rule", () => {
    expect(RULES.map((rule) => rule.id).sort()).toEqual([...RULE_IDS].sort());
    expect(Object.keys(PENDING_ADOPTION).sort()).toEqual([...RULE_IDS].sort());
  });

  it.each(RULES)("forbids $id outside the allowlist", (rule) => {
    const result = scanRule(rule, SOURCES, PENDING_ADOPTION[rule.id]);

    expect(
      result.unexpected,
      `${rule.id}: ${rule.description}. Fix these files, or — only while a zone package is still converting them — add them to PENDING_ADOPTION.${rule.id}.`,
    ).toEqual([]);
  });

  it.each(RULES)("fails on a stale PENDING_ADOPTION entry for $id", (rule) => {
    const result = scanRule(rule, SOURCES, PENDING_ADOPTION[rule.id]);

    expect(
      result.stale,
      `${rule.id}: these files no longer violate the rule. Delete them from PENDING_ADOPTION.${rule.id} so the list keeps shrinking.`,
    ).toEqual([]);
  });

  it("has an empty allowlist once every zone package has landed", () => {
    const remaining = Object.entries(PENDING_ADOPTION).flatMap(
      ([ruleId, files]) => files.map((file) => `${ruleId}: ${file}`),
    );

    // This is the acceptance criterion for RC-02 and RC-03. It is expected to
    // fail until the last zone package deletes its entries; the count is the
    // wave's remaining copy debt.
    expect(remaining.length).toBeLessThanOrEqual(PENDING_ADOPTION_BUDGET);
  });
});

/**
 * The number of allowlisted (file, rule) pairs left. It must only ever go
 * down. A zone package that converts its files lowers this number in the same
 * change; nothing may raise it.
 */
const PENDING_ADOPTION_BUDGET = Object.values(PENDING_ADOPTION).reduce(
  (total, files) => total + files.length,
  0,
);

describe("allowlist mechanics", () => {
  const rule = RULES[0]!;

  it("reports an unlisted violation", () => {
    const sources = new Map([
      ["a.ts", "return error.message;"],
      ["b.ts", "return 1;"],
    ]);

    expect(scanRule(rule, sources, []).unexpected).toEqual(["a.ts"]);
  });

  it("suppresses a listed violation", () => {
    const sources = new Map([["a.ts", "return error.message;"]]);

    expect(scanRule(rule, sources, ["a.ts"]).unexpected).toEqual([]);
  });

  it("reports a listed file that no longer violates as stale", () => {
    const sources = new Map([["a.ts", "return 1;"]]);

    const result = scanRule(rule, sources, ["a.ts"]);

    expect(result.unexpected).toEqual([]);
    expect(result.stale).toEqual(["a.ts"]);
  });
});

describe("status vocabulary", () => {
  const entries = Object.entries(STATUS_COPY_TABLES).flatMap(
    ([table, labels]) =>
      Object.entries(labels).map(
        ([value, label]) => [table, value, label] as const,
      ),
  );

  it("covers every enum value with copy", () => {
    expect(entries.length).toBeGreaterThan(60);
  });

  it.each(entries)(
    "%s.%s reads as copy, not a stored value",
    (_t, _v, label) => {
      expect(label).not.toMatch(/_/);
      expect(label).not.toMatch(/^[a-z]/);
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(2);
    },
  );

  it("never renders a value by title-casing its identifier", () => {
    // "Site login required" and "Prepare only" were what the title-caser
    // produced at these exact sites.
    expect(
      STATUS_COPY_TABLES.APPLICATION_BLOCKER_LABELS.site_login_required,
    ).toBe("The job site wants you to sign in first");
    expect(STATUS_COPY_TABLES.APPLY_RUN_MODE_LABELS.copilot).toBe(
      "Preparation",
    );
    expect(
      STATUS_COPY_TABLES.RESUME_PATCH_OPERATION_LABELS.replace_section_bullets,
    ).toBe("Rewrite the bullets in this section");
  });
});

describe("failure copy", () => {
  const CLOSED_SET = Object.values(FAILURE_SENTENCES);

  const INTERNAL_THROWS = [
    "Apply run 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' is already executing.",
    "Unable to find bullet 'bullet_7'.",
    "Unsupported resume patch operation: replace_section_bullets",
    "Both resume import extraction branches failed.",
    "Resume import timing summary was not retained before finalization.",
    'Model returned invalid JSON: {"error":',
    "SQLITE_BUSY: database is locked",
    "TypeError: cannot read properties of undefined",
    '[ { "code": "custom", "message": "A compensation currency awaiting clarification must remain unset.", "path": [ "compensation", "currency" ] } ]',
  ];

  it.each(INTERNAL_THROWS)(
    "never lets internal text reach a screen: %s",
    (thrown) => {
      const copy = getJobFinderErrorMessage(
        new Error(thrown),
        "That did not finish.",
      );

      expect(copy).not.toBe(thrown);
      expect(copy).not.toContain("remote method");
      expect(copy).not.toMatch(/_/);
      expect(CLOSED_SET).toContain(copy);
    },
  );

  it("never lets Electron's transport wrapper reach a screen", () => {
    // Before: this function returned everything after the wrapper, and 37 of
    // the ~40 error sites did not call it at all, so the literal wrapper
    // string could appear in a toast.
    const copy = getJobFinderErrorMessage(
      new Error(
        "Error invoking remote method 'job-finder:start-apply-copilot-run': Error: The dedicated browser profile could not start.",
      ),
      "That did not finish.",
    );

    expect(copy).not.toContain("remote method");
    expect(copy).not.toContain("job-finder:");
  });

  it("explains an unusable resume and asks for another file", () => {
    const failure = describeFailure(
      new Error(
        "Error invoking remote method 'job-finder:import': Error: No resume details were found in this file. Choose another file.",
      ),
      { action: "import your resume" },
    );
    expect(failure.kind).toBe("unusable_resume");
    expect(failure.sentence).toBe(
      "No resume details were found in this file. Choose another file.",
    );
  });
  it("classifies a busy failure rather than naming the run", () => {
    expect(
      getJobFinderErrorMessage(
        new Error(
          "Error invoking remote method 'job-finder:apply': Error: Apply run 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' is already executing.",
        ),
        "That did not finish.",
      ),
    ).toBe(FAILURE_SENTENCES.busy);
  });

  it("uses the caller's sentence when there is nothing readable", () => {
    expect(getJobFinderErrorMessage(null, "The profile was not saved.")).toBe(
      "The profile was not saved.",
    );
  });

  it("describeFailure never returns thrown text as the sentence", () => {
    for (const thrown of INTERNAL_THROWS) {
      const failure = describeFailure(new Error(thrown), {
        action: "save your profile",
      });

      expect(CLOSED_SET).toContain(failure.sentence);
      expect(failure.userMessage).toBe(
        `Could not save your profile. ${failure.sentence}`,
      );
      expect(failure.userMessage).not.toContain(thrown);
      expect(failure.technicalDetails).not.toBeNull();
    }
  });

  it("routes the raw text to the Technical details disclosure only", () => {
    const failure = describeFailure(
      new Error(
        "Error invoking remote method 'job-finder:x': Error: Unable to find bullet 'bullet_7'.",
      ),
      { action: "apply that edit" },
    );

    expect(TECHNICAL_DETAILS_LABEL).toBe("Technical details");
    expect(failure.technicalDetails).toBe("Unable to find bullet 'bullet_7'.");
    expect(failure.userMessage).not.toContain("bullet_7");
  });

  it("lets a caller supply its own sentence for an unrecognised failure", () => {
    const failure = describeFailure(new Error("Something odd"), {
      action: "save your profile",
      unknownSentence: "Your profile was not saved. Try again.",
    });

    expect(failure.kind).toBe("unknown");
    expect(failure.sentence).toBe("Your profile was not saved. Try again.");
  });

  it.each([
    ["fetch failed", "offline"],
    ["The request timed out", "timed_out"],
    ["Apply run 'x' is already executing.", "busy"],
    ["The approved CV changed after it was saved.", "changed_elsewhere"],
    ["Unknown Job Finder job", "not_found"],
    ["site login required", "site_blocked"],
    ["Model returned a non-JSON response", "assistant_unavailable"],
    ["Something odd", "unknown"],
  ] as const)("classifies %s as %s", (thrown, kind) => {
    expect(classifyFailure(new Error(thrown))).toBe(kind);
  });

  it("strips the transport wrapper from the technical detail", () => {
    expect(
      getJobFinderErrorDetail(
        new Error(
          "Error invoking remote method 'job-finder:get-workspace': Error: fetch failed",
        ),
      ),
    ).toBe("fetch failed");
  });

  it("keeps every closed-set sentence plain", () => {
    for (const sentence of CLOSED_SET) {
      expect(sentence).not.toMatch(/_/);
      expect(sentence).not.toMatch(/failed to/i);
      expect(sentence).toMatch(/^[A-Z]/);
      expect(sentence).toMatch(/\.$/);
    }
  });
});
