import { APPLICATION_BOUNDARY_SENTENCE } from "../safeguards/safeguards-application-boundary";
import { CreateApplicationAuthorityEnvelopeInputSchema } from "@nestor/contracts";
import type {
  ApplicationAttestationKind,
  ApplicationAutomationMode,
  ApplicationSalaryDisclosureRule,
  ApplicationAuthorityReadiness,
  ApplicationAuthorityEnvelope,
  ApplicationAuthorityEnvelopeMutationResult,
  CreateApplicationAuthorityEnvelopeInput,
  UpdateApplicationAuthorityEnvelopeInput,
} from "@nestor/contracts";
import { useEffect, useId, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { ToggleField } from "@renderer/features/job-finder/components/toggle-field";
import { getJobFinderDateInputLocale } from "../../lib/job-finder-date-input-locale";

const jobFinderDateInputLocale = getJobFinderDateInputLocale();

type AuthorityApi = Window["nestor"]["jobFinder"];

type AuthorityDraft = {
  mode: ApplicationAutomationMode;
  preApprovedAttestationKinds: ApplicationAttestationKind[];
  salaryDisclosure: ApplicationSalaryDisclosureRule;
  allowedOrigins: string;
  allowedResumeSha256: string;
  campaignId: string;
  expiresAt: string;
  jobIds: string;
  maxApplicationsPerLocalDay: string;
  maxApplicationsPerRun: string;
  intermediateMutationsAuthorized: boolean;
};

const emptyDraft: AuthorityDraft = {
  mode: "prepare_only",
  preApprovedAttestationKinds: [],
  salaryDisclosure: "pause_for_user",
  allowedOrigins: "",
  allowedResumeSha256: "",
  campaignId: "",
  expiresAt: "",
  jobIds: "",
  maxApplicationsPerLocalDay: "",
  maxApplicationsPerRun: "",
  intermediateMutationsAuthorized: false,
};

type LoadState =
  | { message: string | null; status: "idle" | "loading" | "ready" }
  | { message: string; status: "failed" };

const initialLoadState: LoadState = { message: null, status: "idle" };

function splitLines(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toDraft(envelope: ApplicationAuthorityEnvelope): AuthorityDraft {
  return {
    mode: envelope.mode,
    preApprovedAttestationKinds: [
      ...(envelope.decisionPolicy?.answerPolicy.preApprovedAttestationKinds ??
        []),
    ],
    salaryDisclosure:
      envelope.decisionPolicy?.answerPolicy.salaryDisclosure ??
      "pause_for_user",
    allowedOrigins: envelope.allowedOrigins.join("\n"),
    allowedResumeSha256: envelope.allowedResumeSha256.join("\n"),
    campaignId: envelope.scope.campaignId ?? "",
    expiresAt: envelope.expiresAt
      ? applicationAuthorityIsoToLocalDateTimeInput(envelope.expiresAt)
      : "",
    jobIds: envelope.scope.jobIds.join("\n"),
    maxApplicationsPerLocalDay: String(envelope.maxApplicationsPerLocalDay),
    maxApplicationsPerRun: String(envelope.maxApplicationsPerRun),
    intermediateMutationsAuthorized: envelope.intermediateMutationsAuthorized,
  };
}

export function applicationAuthorityIsoToLocalDateTimeInput(
  value: string,
): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoDateTime(value: string): string | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : value.trim();
}

function buildPolicyInput(
  draft: AuthorityDraft,
): CreateApplicationAuthorityEnvelopeInput {
  return {
    allowedOrigins: splitLines(draft.allowedOrigins),
    allowedResumeSha256: splitLines(draft.allowedResumeSha256),
    expiresAt: toIsoDateTime(draft.expiresAt),
    intermediateMutationsAuthorized: draft.intermediateMutationsAuthorized,
    maxApplicationsPerLocalDay: Number(draft.maxApplicationsPerLocalDay),
    maxApplicationsPerRun: Number(draft.maxApplicationsPerRun),
    mode: draft.mode,
    preApprovedAttestationKinds: draft.preApprovedAttestationKinds,
    salaryDisclosure: draft.salaryDisclosure,
    scope: {
      campaignId: draft.campaignId.trim() || null,
      jobIds: splitLines(draft.jobIds),
    },
  };
}

function mutationMessage(
  result: ApplicationAuthorityEnvelopeMutationResult,
  action: "saved" | "revoked",
): string {
  if (result.status === "applied") {
    return action === "revoked"
      ? "What Job Finder may do has been taken back. It can no longer open or fill this application for you."
      : result.envelope.intermediateMutationsAuthorized
        ? "Saved. Job Finder may fill this application and let the site save answers as it goes. It still cannot send the application."
        : "Saved. Job Finder may fill this application. It cannot let the site save answers as it goes, and it cannot send the application.";
  }
  if (result.status === "stale") {
    return "This envelope changed elsewhere. The current revision was reloaded; review it before trying again.";
  }
  return "This saved setting no longer exists. The list was refreshed.";
}

/**
 * The three things Job Finder can do with an application, said as what
 * happens rather than as the name of a setting.
 */
const applicationModeChoices: ReadonlyArray<{
  value: ApplicationAutomationMode;
  title: string;
  description: string;
}> = [
  {
    value: "prepare_only",
    title: "Fill applications in and stop",
    description:
      "Job Finder opens the application, fills what it can, and leaves it. You read it and send it yourself.",
  },
  {
    value: "confirm_before_submit",
    title: "Fill them in and ask me before sending",
    description:
      "Job Finder fills everything in and shows you what it wrote. One tap from you sends it.",
  },
  {
    value: "autonomous_submit",
    title: "Fill them in and send them",
    description:
      "Job Finder sends applications that fall inside everything you set below. It still stops for anything it cannot answer honestly.",
  },
];

/**
 * The declarations a form can ask a person to make. Each is described as the
 * thing being signed, because that is what the person is agreeing to.
 */
const attestationChoices: ReadonlyArray<{
  value: ApplicationAttestationKind;
  label: string;
  description: string;
}> = [
  {
    value: "truthfulness_certification",
    label: "That everything you have said is true",
    description:
      "Forms often end with a line certifying your answers are accurate. Job Finder only ever fills in facts from your profile and resume.",
  },
  {
    value: "terms_acceptance",
    label: "The employer's application terms",
    description: "Accepting the terms and conditions attached to applying.",
  },
  {
    value: "privacy_notice_acknowledgement",
    label: "How they will use your data",
    description:
      "Acknowledging a privacy notice about handling your application.",
  },
  {
    value: "background_check_consent",
    label: "Consent to a background check",
    description:
      "Agreeing they may run a background or reference check on you.",
  },
  {
    value: "equal_opportunity_self_identification",
    label: "Equal-opportunity questions about you",
    description:
      "Voluntary questions about race, gender, veteran status, or disability. These are always yours to answer; leave this off unless you want your profile's answers used.",
  },
  {
    value: "marketing_contact_consent",
    label: "Hearing from them about other roles",
    description:
      "Opting in to future openings and talent-community mail. Usually optional.",
  },
];

/**
 * Human labels for the stored answer identifiers. A job seeker reading
 * Settings must never be shown `self_intro`.
 */
const reusableAnswerKindLabels: Record<string, string> = {
  work_authorization: "Work authorization",
  visa_sponsorship: "Visa sponsorship",
  relocation: "Relocation",
  travel: "Travel",
  notice_period: "Notice period",
  availability: "Availability",
  salary_expectation: "Salary expectations",
  self_intro: "Short self-introduction",
  career_transition: "Career change",
  other: "Other questions",
};

export function formatReusableAnswerKind(kind: string): string {
  return (
    reusableAnswerKindLabels[kind] ??
    kind
      .replaceAll("_", " ")
      .replace(/^./u, (character) => character.toUpperCase())
  );
}

export function SettingsApplicationAuthoritySection({
  headingId: providedHeadingId,
}: {
  /**
   * Lets the Settings screen name this region by the heading the user can
   * actually see. Every other section's region name differs from its visible
   * heading ("App & device" vs "Appearance"), but this one repeated itself
   * word for word as a hidden h2 above an identical visible h3.
   */
  headingId?: string;
} = {}) {
  const generatedHeadingId = useId();
  const headingId = providedHeadingId ?? generatedHeadingId;
  const originsId = useId();
  const resumeDigestsId = useId();
  const campaignId = useId();
  const jobIdsId = useId();
  const maxRunId = useId();
  const maxDayId = useId();
  const expiresAtId = useId();
  const [envelopes, setEnvelopes] = useState<ApplicationAuthorityEnvelope[]>(
    [],
  );
  const [selectedEnvelope, setSelectedEnvelope] =
    useState<ApplicationAuthorityEnvelope | null>(null);
  const [draft, setDraft] = useState<AuthorityDraft>(emptyDraft);
  const [loadState, setLoadState] = useState<LoadState>(initialLoadState);
  const [actionState, setActionState] = useState<LoadState>(initialLoadState);
  const [revocationPending, setRevocationPending] = useState(false);
  const [readiness, setReadiness] =
    useState<ApplicationAuthorityReadiness | null>(null);
  const [approvalConfirming, setApprovalConfirming] = useState(false);

  const authorityApi = (): AuthorityApi | null => {
    if (typeof window === "undefined") {
      return null;
    }
    return window.nestor?.jobFinder ?? null;
  };

  const applyEnvelope = (envelope: ApplicationAuthorityEnvelope | null) => {
    setSelectedEnvelope(envelope);
    setDraft(envelope ? toDraft(envelope) : emptyDraft);
    setRevocationPending(false);
  };

  const loadEnvelopes = async () => {
    const api = authorityApi();
    if (!api) {
      setLoadState({
        message: "Authority management is unavailable in this app session.",
        status: "failed",
      });
      return;
    }
    setLoadState({ message: null, status: "loading" });
    try {
      const result = await api.listApplicationAuthorityEnvelopes();
      const nextReadiness = await api.getApplicationAuthorityReadiness();
      setEnvelopes(result);
      setReadiness(nextReadiness);
      const active = result.find((item) => item.status === "active") ?? null;
      if (!active) {
        applyEnvelope(null);
      } else {
        const current = await api.getApplicationAuthorityEnvelope({
          id: active.id,
        });
        applyEnvelope(current);
      }
      setLoadState({ message: null, status: "ready" });
    } catch {
      setLoadState({
        message: "Could not load application authority. Try again.",
        status: "failed",
      });
    }
  };

  const approveCurrentAnswers = async () => {
    const api = authorityApi();
    if (!api || !readiness || readiness.currentAnswers.entryCount === 0) {
      return;
    }
    setApprovalConfirming(false);
    setActionState({ message: null, status: "loading" });
    try {
      const result = await api.approveCurrentApplicationAnswers({
        expectedProfileRevision: readiness.currentAnswers.sourceProfileRevision,
        confirmedCurrentAnswers: true,
      });
      setReadiness(result.readiness);
      setActionState({
        message:
          result.status === "stale"
            ? "The profile changed while approval was in progress. Reload readiness and review the current answers."
            : result.status === "blocked"
              ? "The current reusable answers are not eligible for approval. Review them in Profile."
              : result.status === "duplicate"
                ? "These reusable answers already match the approved snapshot. Final submission remains unavailable."
                : "Current reusable answers approved as a new immutable snapshot. Final submission remains unavailable.",
        status:
          result.status === "stale" || result.status === "blocked"
            ? "failed"
            : "ready",
      });
    } catch {
      setActionState({
        message:
          "Could not approve the current answers. Reload readiness and try again.",
        status: "failed",
      });
    }
  };

  useEffect(() => {
    void loadEnvelopes();
  }, []);

  const selectEnvelope = async (id: string) => {
    const api = authorityApi();
    if (!api) {
      return;
    }
    try {
      const envelope = await api.getApplicationAuthorityEnvelope({ id });
      applyEnvelope(envelope);
      setActionState({ message: null, status: "idle" });
    } catch {
      setActionState({
        message: "Could not inspect that authority revision. Try again.",
        status: "failed",
      });
    }
  };

  const setDraftValue = <Key extends keyof AuthorityDraft>(
    key: Key,
    value: AuthorityDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setActionState({ message: null, status: "idle" });
  };

  const saveEnvelope = async () => {
    const api = authorityApi();
    if (!api) {
      return;
    }
    const parsed = CreateApplicationAuthorityEnvelopeInputSchema.safeParse(
      buildPolicyInput(draft),
    );
    if (!parsed.success) {
      setActionState({
        message:
          parsed.error.issues[0]?.message ?? "Review the authority fields.",
        status: "failed",
      });
      return;
    }
    setActionState({ message: null, status: "loading" });
    try {
      const result =
        selectedEnvelope?.status === "active"
          ? await api.updateApplicationAuthorityEnvelope({
              ...parsed.data,
              expectedRevision: selectedEnvelope.revision,
              id: selectedEnvelope.id,
            } satisfies UpdateApplicationAuthorityEnvelopeInput)
          : await api.createApplicationAuthorityEnvelope(
              parsed.data satisfies CreateApplicationAuthorityEnvelopeInput,
            );
      setActionState(
        result.status === "applied"
          ? {
              message: mutationMessage(result, "saved"),
              status: "ready",
            }
          : { message: mutationMessage(result, "saved"), status: "failed" },
      );
      if (result.status === "applied") {
        setEnvelopes((current) => {
          const withoutOld = current.filter(
            (item) => item.id !== result.envelope.id,
          );
          return [result.envelope, ...withoutOld];
        });
        applyEnvelope(result.envelope);
      } else if (result.status === "stale") {
        applyEnvelope(result.current);
        await loadEnvelopes();
      } else {
        applyEnvelope(null);
        await loadEnvelopes();
      }
    } catch {
      setActionState({
        message:
          "The authority change was not saved. Review the fields and retry.",
        status: "failed",
      });
    }
  };

  const revokeEnvelope = async () => {
    if (!selectedEnvelope || selectedEnvelope.status !== "active") {
      return;
    }
    const api = authorityApi();
    if (!api) {
      return;
    }
    setActionState({ message: null, status: "loading" });
    try {
      const result = await api.revokeApplicationAuthorityEnvelope({
        expectedRevision: selectedEnvelope.revision,
        id: selectedEnvelope.id,
      });
      setActionState({
        message: mutationMessage(result, "revoked"),
        status: result.status === "applied" ? "ready" : "failed",
      });
      await loadEnvelopes();
    } catch {
      setActionState({
        message: "That did not go back to fill-and-stop. Try again.",
        status: "failed",
      });
    }
  };

  const activeSelected = selectedEnvelope?.status === "active";
  // A saved permission that is no longer active is read-only history.
  const selectedNonDraftable =
    selectedEnvelope !== null && selectedEnvelope.status !== "active";
  const sendingModeSelected = draft.mode !== "prepare_only";
  const canSave =
    (!sendingModeSelected ||
      (readiness?.answerApprovalStatus === "current" &&
        draft.expiresAt.trim().length > 0 &&
        splitLines(draft.allowedResumeSha256).length > 0 &&
        (draft.campaignId.trim().length > 0 ||
          splitLines(draft.jobIds).length > 0))) &&
    draft.allowedOrigins.trim().length > 0 &&
    draft.maxApplicationsPerRun.trim().length > 0 &&
    draft.maxApplicationsPerLocalDay.trim().length > 0 &&
    (!draft.intermediateMutationsAuthorized ||
      (readiness?.answerApprovalStatus === "current" &&
        splitLines(draft.allowedOrigins).length === 1 &&
        splitLines(draft.allowedResumeSha256).length === 1 &&
        draft.campaignId.trim().length === 0 &&
        splitLines(draft.jobIds).length === 1 &&
        draft.expiresAt.trim().length > 0));

  /**
   * What this choice will actually do, once everything it needs is in place.
   * One sentence, in the same words the choice itself uses.
   */
  const selectedModeOutcomeSentence =
    draft.mode === "prepare_only"
      ? "Job Finder will open each application, fill in what it can, and stop. Reading it and sending it stays yours."
      : draft.mode === "confirm_before_submit"
        ? "Job Finder will fill each application in and show you what it wrote. Nothing goes to an employer until you send it."
        : "Job Finder will fill applications in and send the ones that fall inside the limits below. It still stops for anything it cannot answer honestly.";

  /** Moves the person to the field a prerequisite is asking them to fill. */
  const focusField = (fieldId: string) => {
    const field = document.getElementById(fieldId);
    if (field instanceof HTMLElement) {
      field.scrollIntoView({ block: "center" });
      field.focus();
    }
  };

  /**
   * Everything this choice still needs, each with the one control that
   * supplies it. An empty list means the choice is ready to save.
   */
  const missingPrerequisites: ReadonlyArray<{
    id: string;
    explanation: string;
    actionLabel: string;
    onAct: () => void;
  }> = [
    ...(sendingModeSelected && readiness?.answerApprovalStatus !== "current"
      ? [
          {
            id: "approved-answers",
            explanation:
              "Approving your saved answers lets Job Finder reuse exactly the answers you checked in Profile, and nothing else.",
            actionLabel: "Approve your saved answers",
            onAct: () => setApprovalConfirming(true),
          },
        ]
      : []),
    // Only the sending modes need a named site. Fill-and-stop writes nothing
    // anywhere and prepares perfectly well with no website listed, so asking
    // for one there invented a missing step that was never missing.
    ...(sendingModeSelected && draft.allowedOrigins.trim().length === 0
      ? [
          {
            id: "allowed-origins",
            explanation:
              "Websites Job Finder may send applications on. Sending is limited to the sites you name here, and nowhere else.",
            actionLabel: "Add a website",
            onAct: () => focusField(originsId),
          },
        ]
      : []),
    ...(sendingModeSelected &&
    splitLines(draft.allowedResumeSha256).length === 0
      ? [
          {
            id: "resume-fingerprint",
            explanation:
              "Job Finder checks the resume file against this fingerprint, so a different file cannot go out by mistake.",
            actionLabel: "Add the resume fingerprint",
            onAct: () => focusField(resumeDigestsId),
          },
        ]
      : []),
    ...(sendingModeSelected &&
    draft.campaignId.trim().length === 0 &&
    splitLines(draft.jobIds).length === 0
      ? [
          {
            id: "scope",
            explanation:
              "Say which jobs this covers — a search plan or a list of job IDs — so it can never apply to something you did not mean.",
            actionLabel: "Choose which jobs this covers",
            onAct: () => focusField(jobIdsId),
          },
        ]
      : []),
    ...(sendingModeSelected && draft.expiresAt.trim().length === 0
      ? [
          {
            id: "expiry",
            explanation:
              "Pick a date this stops applying. It expires on its own rather than staying on forever.",
            actionLabel: "Set when this expires",
            onAct: () => focusField(expiresAtId),
          },
        ]
      : []),
  ];

  return (
    <section className="surface-panel-shell grid min-w-0 content-start gap-3 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[72ch] flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3
              className="min-w-0 font-semibold text-(--text-headline)"
              id={headingId}
            >
              What Job Finder may do on application sites
            </h3>
          </div>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            {APPLICATION_BOUNDARY_SENTENCE}
          </p>
        </div>
        <Button
          disabled={loadState.status === "loading"}
          onClick={() => void loadEnvelopes()}
          type="button"
          variant="secondary"
        >
          {loadState.status === "loading" ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {/* Three choices, in the order of how much they do for you. The words
          are what happens, not the name of a mode. */}
      <div
        className="grid min-w-0 gap-2"
        role="radiogroup"
        aria-label="How much Job Finder does for you"
      >
        {applicationModeChoices.map((choice) => (
          <button
            aria-checked={draft.mode === choice.value}
            className={`grid min-w-0 gap-1.5 rounded-(--radius-field) border p-3.5 text-left transition-colors ${draft.mode === choice.value ? "border-primary/70 bg-primary/8" : "border-(--surface-panel-border) bg-background/45 hover:border-primary/35"}`}
            disabled={selectedNonDraftable}
            key={choice.value}
            onClick={() => setDraftValue("mode", choice.value)}
            role="radio"
            type="button"
          >
            <span className="font-semibold text-foreground">
              {choice.title}
            </span>
            <span className="text-sm leading-5 text-foreground-soft">
              {choice.description}
            </span>
          </button>
        ))}
      </div>

      {/* What this choice means, in one sentence, and then one button for each
          thing still missing. The section used to state "Not approved" with no
          way forward, which is a dead end rather than a next step. */}
      <div
        className="grid min-w-0 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 p-3.5"
        data-testid="application-automation-outcome"
      >
        <p className="text-sm leading-5 text-foreground">
          {selectedModeOutcomeSentence}
        </p>
        {missingPrerequisites.length > 0 ? (
          <ul
            className="m-0 grid min-w-0 list-none gap-2 p-0"
            data-testid="application-automation-prerequisites"
          >
            {missingPrerequisites.map((prerequisite) => (
              <li className="grid min-w-0 gap-1" key={prerequisite.id}>
                <span className="text-sm leading-5 text-foreground-soft">
                  {prerequisite.explanation}
                </span>
                <Button
                  className="w-fit max-w-full"
                  disabled={selectedNonDraftable}
                  onClick={prerequisite.onAct}
                  type="button"
                  variant="secondary"
                >
                  {prerequisite.actionLabel}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {sendingModeSelected ? (
        <article className="grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-3.5">
          <div className="grid gap-1">
            <h4 className="font-semibold text-foreground">
              Things forms ask you to declare
            </h4>
            <p className="text-sm leading-5 text-foreground-soft">
              Tick only what you are happy for Job Finder to answer on your
              behalf. Anything you leave unticked stops and waits for you.
            </p>
          </div>
          <div className="grid gap-2">
            {attestationChoices.map((choice) => (
              <ToggleField
                checked={draft.preApprovedAttestationKinds.includes(
                  choice.value,
                )}
                description={choice.description}
                disabled={selectedNonDraftable}
                key={choice.value}
                label={choice.label}
                onCheckedChange={(checked) =>
                  setDraftValue(
                    "preApprovedAttestationKinds",
                    checked
                      ? [...draft.preApprovedAttestationKinds, choice.value]
                      : draft.preApprovedAttestationKinds.filter(
                          (kind) => kind !== choice.value,
                        ),
                  )
                }
              />
            ))}
          </div>
          <ToggleField
            checked={draft.salaryDisclosure === "answer_from_profile"}
            description="Covers expected pay, current pay and pay history. Off: optional pay fields stay blank; required pay questions wait for you."
            disabled={selectedNonDraftable}
            label="Let Job Finder answer expected and current pay questions"
            onCheckedChange={(checked) =>
              setDraftValue(
                "salaryDisclosure",
                checked ? "answer_from_profile" : "pause_for_user",
              )
            }
          />
        </article>
      ) : null}

      <article
        aria-label="Answers Job Finder can reuse"
        className="surface-card-tint grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-3.5"
      >
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="grid min-w-0 gap-1">
            <h4 className="font-semibold text-(--text-headline)">
              Answers Job Finder can reuse
            </h4>
            <p className="text-sm leading-5 text-foreground-soft">
              These are the answers you saved in Profile — work authorization,
              notice period, and similar. Review them in Profile, then approve
              them here so Job Finder reuses exactly what you checked.
            </p>
            <a
              className="w-fit text-sm font-semibold text-primary underline-offset-4 hover:underline"
              href="/job-finder/profile"
            >
              Review answers in Profile
            </a>
          </div>
          {readiness ? (
            <span className="label-mono-xs">
              {readiness.answerApprovalStatus === "current"
                ? "Current"
                : readiness.answerApprovalStatus === "stale"
                  ? "Needs review"
                  : "Needs approving"}
            </span>
          ) : null}
        </div>
        {readiness ? (
          <>
            <dl className="m-0 grid min-w-0 gap-3 sm:grid-cols-3">
              <div className="grid min-w-0 gap-1">
                <dt className="label-mono-xs">Reusable answers</dt>
                <dd className="m-0 text-sm text-foreground">
                  {/* "kind" is a schema word, and the two counts said almost
                      the same thing. One count, in English. */}
                  {readiness.currentAnswers.entryCount === 1
                    ? "1 answer saved"
                    : `${readiness.currentAnswers.entryCount} answers saved`}
                </dd>
              </div>
              <div className="grid min-w-0 gap-1">
                <dt className="label-mono-xs">Questions covered</dt>
                <dd className="m-0 break-words text-sm text-foreground">
                  {/* Never the stored identifier: a job seeker cannot act on
                      "self_intro". */}
                  {readiness.currentAnswers.kinds.length > 0
                    ? readiness.currentAnswers.kinds
                        .map((kind) => formatReusableAnswerKind(kind))
                        .join(", ")
                    : "None yet"}
                </dd>
              </div>
              <div className="grid min-w-0 gap-1">
                <dt className="label-mono-xs">Approved for reuse</dt>
                <dd className="m-0 break-words text-sm text-foreground">
                  {readiness.approvedSnapshot
                    ? `Approved (version ${readiness.approvedSnapshot.revision})`
                    : "Not approved yet — use the button above"}
                </dd>
              </div>
            </dl>
            {readiness.blockers.length > 0 ? (
              <ul className="m-0 grid gap-1 pl-5 text-sm leading-5 text-foreground-soft">
                {readiness.blockers.map((blocker) => (
                  <li key={blocker.code}>
                    {blocker.code === "no_reusable_answers"
                      ? "Add reusable answers in Profile."
                      : blocker.code === "required_answer_missing"
                        ? `Answer these in Profile first: ${readiness.currentAnswers.missingRequiredKinds
                            .map((kind) => formatReusableAnswerKind(kind))
                            .join(", ")}.`
                        : blocker.code === "no_approved_answer_snapshot"
                          ? "Read your reusable answers in Profile, then approve them here."
                          : blocker.code === "approved_answer_snapshot_stale"
                            ? "The profile changed since approval; review and approve again."
                            : "Sending applications automatically is not available in this version."}
                  </li>
                ))}
              </ul>
            ) : null}
            {readiness.currentAnswers.entryCount > 0 &&
            readiness.answerApprovalStatus !== "current" ? (
              approvalConfirming ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-sm text-foreground-soft">
                    Confirm that you reviewed the current reusable answers in
                    Profile and want to save them as an immutable snapshot.
                  </span>
                  <Button
                    disabled={actionState.status === "loading"}
                    onClick={() => void approveCurrentAnswers()}
                    type="button"
                  >
                    Confirm and approve
                  </Button>
                  <Button
                    onClick={() => setApprovalConfirming(false)}
                    type="button"
                    variant="secondary"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  // A 1060px bar is not a button.
                  className="w-fit max-w-full"
                  onClick={() => setApprovalConfirming(true)}
                  type="button"
                  variant="secondary"
                >
                  Approve current answers
                </Button>
              )
            ) : null}
          </>
        ) : (
          <p className="text-sm text-foreground-soft">Loading readiness…</p>
        )}
      </article>

      {loadState.status === "failed" ? (
        <p className="text-sm leading-5 text-destructive" role="alert">
          {loadState.message}
        </p>
      ) : null}
      {envelopes.length > 0 ? (
        <div
          className="grid min-w-0 gap-2"
          aria-label="Saved application-automation settings"
          role="list"
        >
          {envelopes.map((envelope) => (
            <button
              className={`flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-(--radius-field) border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 ${selectedEnvelope?.id === envelope.id ? "border-primary/70 bg-primary/8" : "border-(--surface-panel-border) hover:border-primary/35"}`}
              key={envelope.id}
              onClick={() => void selectEnvelope(envelope.id)}
              type="button"
            >
              <span className="min-w-0 truncate">
                {envelope.mode.replaceAll("_", " ")}
              </span>
              <span className="shrink-0 text-xs text-foreground-soft">
                {envelope.status} · revision {envelope.revision}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-(--radius-field) border border-dashed border-(--surface-panel-border) px-3.5 py-3 text-sm leading-5 text-foreground-soft">
          Nothing saved yet. Job Finder still only prepares applications for
          your review; saving a permission below records what you allowed and
          does not let it send anything.
        </p>
      )}

      {selectedNonDraftable ? (
        <p
          className="rounded-(--radius-field) border border-warning/40 bg-warning/8 px-3.5 py-3 text-sm leading-5 text-foreground-soft"
          role="status"
        >
          This permission is no longer in force. You can read what it allowed,
          but it cannot be edited or switched back on.
        </p>
      ) : null}

      <div className="grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5">
        <div className="grid gap-1">
          <h4 className="font-semibold text-foreground">
            Let Job Finder fill applications on one site
          </h4>
          <p className="text-sm leading-5 text-foreground-soft">
            Job Finder assumes nothing: the site, the resume file, the job, and
            the limits below are all entered by you. It still never sends the
            application.
          </p>
        </div>
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={originsId}>
              Website Job Finder may fill on (required)
            </FieldLabel>
            <Textarea
              aria-describedby={`${originsId}-hint`}
              id={originsId}
              onChange={(event) =>
                setDraftValue("allowedOrigins", event.target.value)
              }
              placeholder="https://jobs.example.com"
              value={draft.allowedOrigins}
            />
            <p
              className="text-xs leading-4 text-foreground-soft"
              id={`${originsId}-hint`}
            >
              One web address per line, and exactly one to let the site save
              your answers as you go. Give the address only — no page path and
              nothing after a "?".
            </p>
          </Field>
          <Field>
            <FieldLabel htmlFor={resumeDigestsId}>
              Resume file fingerprint
            </FieldLabel>
            <Textarea
              aria-describedby={`${resumeDigestsId}-hint`}
              id={resumeDigestsId}
              onChange={(event) =>
                setDraftValue("allowedResumeSha256", event.target.value)
              }
              placeholder="One 64-character fingerprint per line"
              value={draft.allowedResumeSha256}
            />
            <p
              className="text-xs leading-4 text-foreground-soft"
              id={`${resumeDigestsId}-hint`}
            >
              The fingerprint identifies the exact resume file you approved, so
              a different file cannot be sent by mistake. Letting the site save
              your answers as you go needs exactly one, and it is checked again
              when Job Finder fills the form.
            </p>
          </Field>
          <Field>
            <FieldLabel htmlFor={campaignId}>
              Search plan scope (autosave requires blank)
            </FieldLabel>
            <Input
              id={campaignId}
              onChange={(event) =>
                setDraftValue("campaignId", event.target.value)
              }
              value={draft.campaignId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={jobIdsId}>
              Job IDs (autosave requires exactly one)
            </FieldLabel>
            <Textarea
              id={jobIdsId}
              onChange={(event) => setDraftValue("jobIds", event.target.value)}
              placeholder="One job ID per line"
              value={draft.jobIds}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={maxRunId}>
              Maximum applications per run
            </FieldLabel>
            <Input
              id={maxRunId}
              min="1"
              onChange={(event) =>
                setDraftValue("maxApplicationsPerRun", event.target.value)
              }
              type="number"
              value={draft.maxApplicationsPerRun}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={maxDayId}>
              Maximum applications per local day
            </FieldLabel>
            <Input
              id={maxDayId}
              min="1"
              onChange={(event) =>
                setDraftValue("maxApplicationsPerLocalDay", event.target.value)
              }
              type="number"
              value={draft.maxApplicationsPerLocalDay}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={expiresAtId}>Expires at</FieldLabel>
            <Input
              id={expiresAtId}
              onChange={(event) =>
                setDraftValue("expiresAt", event.target.value)
              }
              lang={jobFinderDateInputLocale}
              type="datetime-local"
              value={draft.expiresAt}
            />
          </Field>
        </div>
        <ToggleField
          checked={draft.intermediateMutationsAuthorized}
          description="Lets the job site save a draft of an answer the moment Job Finder types it, and only on the site above. Sending the application, creating an account, entering a password, and answering a security check all stay blocked."
          disabled={readiness?.answerApprovalStatus !== "current"}
          hint={
            readiness?.answerApprovalStatus === "current"
              ? "Saving is a second, separate step. Job Finder still needs exactly one job, one resume file, one website, the answers you approved, and an expiry date in the future before it will fill anything."
              : "Approve the current reusable answers above before this capability can be selected."
          }
          label="Let the job site save answers as Job Finder fills them"
          onCheckedChange={(checked) =>
            setDraftValue("intermediateMutationsAuthorized", checked)
          }
        />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            disabled={
              !canSave ||
              loadState.status === "loading" ||
              actionState.status === "loading" ||
              selectedNonDraftable
            }
            onClick={() => void saveEnvelope()}
            pending={actionState.status === "loading"}
            type="button"
            variant="primary"
          >
            {selectedNonDraftable ? "Editing unavailable" : "Save"}
          </Button>
          {actionState.status !== "idle" && actionState.message ? (
            <p
              className={
                actionState.status === "failed"
                  ? "text-sm leading-5 text-destructive"
                  : "text-sm leading-5 text-foreground-soft"
              }
              role="status"
            >
              {actionState.message}
            </p>
          ) : null}
        </div>
      </div>

      {/* The way back, under the section rather than beside the thing you
          came here to do. It is one plain sentence about what changes. */}
      {activeSelected ? (
        <div
          className="grid min-w-0 gap-2 border-t border-(--surface-panel-border) pt-3"
          data-testid="application-automation-step-back"
        >
          {revocationPending ? (
            <>
              <p className="text-sm leading-5 text-foreground" role="alert">
                Job Finder will go back to filling applications in and stopping.
                It keeps nothing it was allowed to do beyond that, and you can
                choose a wider setting again later.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={actionState.status === "loading"}
                  onClick={() => void revokeEnvelope()}
                  type="button"
                  variant="secondary"
                >
                  Go back to fill-and-stop
                </Button>
                <Button
                  disabled={actionState.status === "loading"}
                  onClick={() => setRevocationPending(false)}
                  type="button"
                  variant="ghost"
                >
                  Keep this setting
                </Button>
              </div>
            </>
          ) : (
            <Button
              className="w-fit max-w-full"
              disabled={actionState.status === "loading"}
              onClick={() => setRevocationPending(true)}
              type="button"
              variant="ghost"
            >
              Go back to fill-and-stop
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
