import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Question, Run } from "./types.ts";

export const SCENARIOS = [
  ["standard", "Standard application"],
  ["multistep", "Workday four steps"],
  ["captcha", "CAPTCHA and auto-resume"],
  ["security", "Eight-second security check"],
  ["restart", "Restart filled application"],
  ["batch", "Ten approved applications"],
  ["send", "Send once and retry"],
  ["needs-you", "Needs you quality"],
  ["self-limits", "Our own limits"],
  ["search", "Seven-source search recovery"],
  ["google", "Google sign-in (on and off)"],
  ["saved-sign-in", "Saved-password sign-in"],
  ["browser-import", "Browser import (synthetic fallback)"],
] as const;

export const PERSONA = {
  name: "Jamie Rivers",
  resume: "apps/desktop/test-fixtures/job-finder/resume-import-sample.txt",
  email: "jamie@example.com",
  location: "Berlin, Germany",
  authorizedWorkCountries: ["European Union", "Germany"],
  requiresVisaSponsorship: false,
  remoteEligible: true,
  noticePeriodDays: 30,
  noticePeriodMeaning: "1 month (stored as 30 days in the app)",
  workModes: ["remote", "hybrid"],
  salaryDisclosure: "pause_for_user",
  paySetting: "Pause for me (pay-answer switch off)",
  resumeLevel: "original",
  syntheticAccount: "scoreboard@example.test; made-up replica-only password",
  applicationOnlyAnswers: {
    jobSource: "Job board",
    streetAddress: "12 Example Street",
    postalCode: "10115",
    experienceStartMonth:
      "2018-01 (made-up application-only detail; absent from the resume)",
  },
};

const EU = new Set(
  "EU|European Union|AT|Austria|BE|Belgium|BG|Bulgaria|HR|Croatia|CY|Cyprus|CZ|Czechia|Czech Republic|DK|Denmark|EE|Estonia|FI|Finland|FR|France|DE|DEU|Germany|GR|Greece|HU|Hungary|IE|Ireland|IT|Italy|LV|Latvia|LT|Lithuania|LU|Luxembourg|MT|Malta|NL|Netherlands|PL|Poland|PT|Portugal|RO|Romania|SK|Slovakia|SI|Slovenia|ES|Spain|SE|Sweden"
    .toLowerCase()
    .split("|"),
);

/** Conservative, inspectable rules. Unknown and mixed-scope asks stay unclassified. */
export function profileAnswer(text: string, key = "", country = "") {
  const question = `${key} ${text}`.toLowerCase();
  if (
    /\b(citizenship|citizen|nationality|clearance|criminal|background|consent|terms|salary|pay|compensation|address|postal|start date|travel|relocat)\b/.test(
      question,
    )
  )
    return null;
  const foreignScope =
    (country !== "" && !EU.has(country.toLowerCase().trim())) ||
    /united states|\busa?\b|united kingdom|northern ireland|\buk\b|canada|australia|worldwide|any country/.test(
      question,
    );
  if (/sponsor|visa/.test(question))
    return foreignScope ? null : "requiresVisaSponsorship=false";
  if (
    /authoriz|authoris|right.to.work|legally.*work|eligible.*work/.test(
      question,
    )
  ) {
    if (foreignScope) return null;
    if (
      !country &&
      !/\beu\b/.test(question) &&
      ![...EU].some(
        (name) =>
          name.length > 3 && new RegExp(`\\b${name}\\b`, "i").test(text),
      )
    )
      return null;
    return "authorizedWorkCountries=European Union, Germany";
  }
  if (/notice/.test(question)) return "noticePeriodDays=30";
  // This synthetic resume has exactly one experience entry, so its first
  // employer and title are unambiguous. Its dates are absent and stay unknown.
  if (/\bwork experience 1\b/.test(question)) {
    if (/job.title/.test(question))
      return "synthetic resume experience: Staff Frontend Engineer";
    if (/company|employer/.test(question))
      return "synthetic resume experience: Signal Systems";
  }
  if (/remote|hybrid|work.mode/.test(question))
    return "remoteEligible=true; workModes=remote, hybrid";
  if (
    /\b(first.name|last.name|full.name|your.name|email|e-mail|phone|telephone|current.location|current.city|linkedin)\b/.test(
      question,
    )
  )
    return "synthetic resume identity and contact details";
  if (
    /years.*(professional|frontend|front.end|react|typescript).*experience|professional.*experience/.test(
      question,
    )
  )
    return "synthetic resume: 12 years of frontend experience";
  return null;
}

/** Only explicit personal decisions and unknown-country authorization are valid pauses. */
export function genuineQuestion(
  q: Pick<Question, "kind" | "text" | "country" | "profileAnswers">,
) {
  if (q.kind !== "question" || q.profileAnswers) return false;
  if (/press|click|save and continue|next step/i.test(q.text)) return false;
  return (
    (!q.country && /authori[sz]|right.to.work|legally.*work/i.test(q.text)) ||
    /own words|why.*(?:role|company|interested)|tell us|describe|technical skills|strengths|consent|agree|terms|salary|compensation|expected pay|current pay/i.test(
      q.text,
    )
  );
}

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function markDuplicates(questions: Question[]) {
  const seen = new Set<string>();
  return questions.map((q) => {
    let scope = normalize(q.country);
    // Eligibility means the hiring country. Different unresolved locations
    // must not be merged just because both pages say "this country".
    if (
      !scope &&
      q.kind === "question" &&
      /authori[sz]|right.to.work|legally.*work|eligible.*work|sponsor|visa|relocat/i.test(
        q.text,
      ) &&
      q.locations
    ) {
      const locations = [
        ...new Set(q.locations.map(normalize).filter(Boolean)),
      ].sort();
      scope = locations.length
        ? `location:${JSON.stringify(locations)}`
        : `application:${q.applicationIds
            .slice()
            .sort((a, b) => a - b)
            .join(",")}`;
    }
    const key = `${q.instance}|${q.kind}|${scope}|${normalize(q.text)}`;
    const duplicate = seen.has(key);
    seen.add(key);
    return { ...q, duplicate };
  });
}

export function auditQuestions(run: Run) {
  const quality = run.results.find((r) => r.id === "needs-you");
  if (!quality) return;
  const cases = run.results.filter(
    (r) => r.id !== "needs-you" && r.id !== "self-limits",
  );
  const questions = new Map<string, Question>();
  for (const r of cases)
    for (const q of r.questions)
      questions.set(`${q.instance}:${q.id}:${q.text}`, q);
  quality.questions = markDuplicates(
    [...questions.values()].sort((a, b) =>
      a.firstSeenAt.localeCompare(b.firstSeenAt),
    ),
  );
  const known = quality.questions.filter((q) => q.profileAnswers).length;
  const duplicates = quality.questions.filter((q) => q.duplicate).length;
  const unmeasured = cases.filter((r) =>
    /^(setup \/|runner$)/.test(r.failure?.step ?? ""),
  );
  const observed = cases.filter(
    (r) => r.status !== "not run" && !unmeasured.includes(r),
  );
  quality.status =
    known || duplicates || unmeasured.length
      ? "fail"
      : observed.length
        ? "pass"
        : "not run";
  quality.metrics.summary = `${quality.questions.length} items; profile answered=${known}; duplicate asks=${duplicates}; coverage=${observed.length}/${SCENARIOS.length - 2} scenarios`;
  quality.metrics.coverage = observed.map((r) => r.id);
  quality.metrics.unmeasured = unmeasured.map((r) => r.id);
  delete quality.failure;
  if (known || duplicates || unmeasured.length)
    quality.failure = {
      step: "aggregate question audit",
      happened: `${known} questions already answered by the profile; ${duplicates} repeated asks.${unmeasured.length ? ` No product measurement for: ${unmeasured.map((r) => r.id).join(", ")}.` : ""}`,
      likelyPackage:
        known || duplicates
          ? "packages/browser-agent/src/apply (question selection/reuse)"
          : "scoreboard runner/setup (question coverage incomplete)",
    };
}

const cell = (value: unknown) =>
  (typeof value === "string" ? value : JSON.stringify(value ?? "—"))
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
export function markdown(run: Run) {
  const lines = [
    "# Job Finder functionality scoreboard",
    "",
    `${run.startedAt} · ${run.source.head.slice(0, 12)}${run.source.dirty ? ` + ${run.source.dirty}` : ""} · live AI · ${run.finishedAt ? `${Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)}s total` : "in progress"}`,
    "",
    "| Scenario | Result | Time | Needs you | Profile answered | Duplicates | Numbers |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const [id] of SCENARIOS) {
    const r = run.results.find((x) => x.id === id);
    if (!r) continue;
    lines.push(
      `| ${cell(r.name)} | ${r.status.toUpperCase()} | ${r.seconds.toFixed(1)}s | ${r.questions.length} | ${r.questions.filter((q) => q.profileAnswers).length} | ${r.questions.filter((q) => q.duplicate).length} | ${cell(r.metrics.summary)} |`,
    );
  }
  for (const r of run.results.filter((x) => x.failure)) {
    const f = r.failure!;
    lines.push(
      "",
      `**${r.name}:** ${f.happened.replace(/\s+/g, " ").slice(0, 1000)} Step: ${f.step}. Likely: ${f.likelyPackage}.`,
    );
  }
  lines.push(
    "",
    "Persona: Jamie Rivers, synthetic resume; unrestricted EU/Germany work permission; no sponsorship; remote or hybrid; 1 month notice (30 days); pay: Pause for me. Original resumes approved through the app.",
    "",
    `Setup: ${run.setupSeconds?.toFixed(1) ?? "—"}s. ${run.preconditions.join(" ")}`,
    "",
    "Question counts include browser handoffs (kind is retained). Profile-answer labels use conservative text/key rules; full text below permits review. The quality row aggregates the other rows and is not an additional set of questions.",
  );
  const questions =
    run.results.find((r) => r.id === "needs-you")?.questions ??
    markDuplicates(run.results.flatMap((r) => r.questions));
  lines.push(
    "",
    "## Every Needs you question",
    "",
    "| Scenario instance / ID | Kind | Question | Country / job locations | Profile answers it | Repeated |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const q of questions)
    lines.push(
      `| ${cell(q.instance)} / ${q.id} | ${cell(q.kind)} | ${cell(q.text)} | ${cell(q.country || q.locations?.join("; ") || "Unknown")} | ${cell(q.profileFact ?? "No known answer")} | ${q.duplicate ? "Yes" : "No"} |`,
    );
  if (!questions.length) lines.push("| — | — | None observed | — | — | — |");
  if (run.cleanup)
    lines.push(
      "",
      `Cleanup: ${run.cleanup.ok ? "passed" : "FAILED"}. ${run.cleanup.detail}`,
    );
  return lines.join("\n") + "\n";
}

export function save(run: Run) {
  for (const result of run.results) {
    result.metrics.needsYouCount = result.questions.length;
    result.metrics.profileAnsweredCount = result.questions.filter(
      (q) => q.profileAnswers,
    ).length;
    result.metrics.duplicateQuestionCount = result.questions.filter(
      (q) => q.duplicate,
    ).length;
  }
  writeFileSync(
    path.join(run.output, "scoreboard.json"),
    JSON.stringify(run, null, 2) + "\n",
  );
  writeFileSync(path.join(run.output, "scoreboard.md"), markdown(run));
}
