import type { ApplicationAuthorityEnvelope } from "@nestor/contracts";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { APPLY_MODE_OPTIONS } from "@renderer/features/job-finder/components/choice-cards";

/**
 * The permission's mode in the words Settings uses for it ("Send for me"),
 * never the stored value.
 */
export function describeEnvelopeMode(
  mode: ApplicationAuthorityEnvelope["mode"],
): string {
  if (mode === "prepare_only") return "Fill for review only";
  return (
    APPLY_MODE_OPTIONS.find((option) => option.id === mode)?.label ??
    "Send for me"
  );
}

/**
 * The whole boundary in one sentence, in the words a job seeker can check
 * against what they see the app do. Safeguards states the person's control
 * over applications, so this sentence lives here verbatim rather than
 * being split across a configuration screen.
 */
export const APPLICATION_BOUNDARY_SENTENCE =
  "Job Finder fills applications and sends them only with your permission. It never asks for a password. If you provide sign-in details and authorize their use, it may use them for that task without saving them. You control account creation; CAPTCHA and MFA stay with you.";

type AuthorityApi = Window["nestor"]["jobFinder"];

function authorityApi(): AuthorityApi | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.nestor?.jobFinder ?? null;
}

function describeEnvelope(envelope: ApplicationAuthorityEnvelope): string {
  const origins =
    envelope.allowedOrigins.length > 0
      ? envelope.allowedOrigins.join(", ")
      : "no site";
  const expiry = envelope.expiresAt
    ? `expires ${new Date(envelope.expiresAt).toLocaleString()}`
    : "no expiry set";
  return `${origins} · ${expiry}`;
}

/**
 * Active application permissions stay inspectable and revocable here, beside
 * the boundary they are bounded by. Revoking asks twice, because it is the
 * one control on this page that changes what the app is allowed to do.
 */
export function SafeguardsApplicationBoundary({
  children,
}: {
  children?: ReactNode;
}) {
  const [envelopes, setEnvelopes] = useState<
    readonly ApplicationAuthorityEnvelope[]
  >([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = authorityApi();
    if (!api) {
      setStatus("failed");
      setMessage("Application permissions are unavailable in this session.");
      return;
    }
    setStatus("loading");
    try {
      const result = await api.listApplicationAuthorityEnvelopes();
      setEnvelopes(result);
      setStatus("ready");
    } catch {
      setStatus("failed");
      setMessage("Application permissions could not be read. Try again.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (envelope: ApplicationAuthorityEnvelope) => {
    const api = authorityApi();
    if (!api) {
      return;
    }
    setPendingId(envelope.id);
    setMessage(null);
    try {
      const result = await api.revokeApplicationAuthorityEnvelope({
        expectedRevision: envelope.revision,
        id: envelope.id,
      });
      setMessage(
        result.status === "applied"
          ? "Permission revoked. Job Finder can no longer send applications using it."
          : "That permission changed elsewhere. The list was refreshed — review it and try again.",
      );
      await load();
    } catch {
      setMessage("The permission was not revoked. Try again.");
    } finally {
      setPendingId(null);
      setConfirmingId(null);
    }
  };

  const activeEnvelopes = envelopes.filter(
    (envelope) => envelope.status === "active",
  );

  return (
    // This card sits directly on the page canvas, so a translucent canvas
    // fill painted it the canvas colour: a 1.00:1 fill delta, leaving a
    // hairline as the only sign the safety contract had a container at all.
    // It now uses the same --card fill as its sibling "Safety events" panel.
    <section
      aria-label="Application boundary"
      className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-card px-4 py-3"
      data-testid="safeguards-application-boundary"
    >
      <h2 className="font-semibold text-(--text-headline)">
        Your application permissions
      </h2>
      <p className="max-w-3xl text-(length:--text-small) leading-6 text-foreground">
        {APPLICATION_BOUNDARY_SENTENCE}
      </p>

      <div className="grid gap-2">
        <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
          Active application permissions
        </p>
        {status === "loading" ? (
          <p
            className="text-(length:--text-small) text-foreground-soft"
            role="status"
          >
            Reading application permissions…
          </p>
        ) : activeEnvelopes.length === 0 ? (
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            None. Job Finder prepares applications for your review only.
          </p>
        ) : (
          <ul className="grid gap-2">
            {activeEnvelopes.map((envelope) => (
              <li
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-(--radius-small) border border-(--surface-panel-border) px-3 py-2"
                key={envelope.id}
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone="neutral">
                      {describeEnvelopeMode(envelope.mode)}
                    </StatusBadge>
                    {envelope.intermediateMutationsAuthorized ? (
                      <StatusBadge tone="active">
                        Saves drafts on the site
                      </StatusBadge>
                    ) : null}
                  </span>
                  <span className="break-words text-(length:--text-small) text-foreground-soft">
                    {describeEnvelope(envelope)}
                  </span>
                </span>
                {confirmingId === envelope.id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-(length:--text-small) text-foreground-soft">
                      Revoke this permission?
                    </span>
                    <Button
                      onClick={() => void revoke(envelope)}
                      pending={pendingId === envelope.id}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      Yes, revoke
                    </Button>
                    <Button
                      onClick={() => setConfirmingId(null)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Keep it
                    </Button>
                  </span>
                ) : (
                  <Button
                    onClick={() => setConfirmingId(envelope.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Revoke permission
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {message ? (
          <p
            className="text-(length:--text-small) leading-5 text-foreground-soft"
            role="status"
          >
            {message}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
