import { AlertTriangle, ArrowLeft, Home, RefreshCcw } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import {
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useRouteError,
} from "react-router-dom";

interface JobFinderRouteErrorBoundaryProps {
  scope: "app" | "route";
}

interface RecoveryCopy {
  description: string;
  kicker: string;
  secondaryAction?: {
    label: string;
    path: string;
  };
  title: string;
}

const STALE_BUNDLE_ERROR_PATTERN =
  /failed to fetch dynamically imported module/i;

function getStaleBundleRecoveryCopy(scope: "app" | "route"): RecoveryCopy {
  const copy: RecoveryCopy = {
    kicker: "App updated",
    title: "The app was updated while it was open",
    description: "Reload to continue with the latest version.",
  };

  if (scope === "route") {
    copy.secondaryAction = {
      label: "Open profile",
      path: "/job-finder/profile",
    };
  }

  return copy;
}

function isStaleBundleError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : null;

  return message !== null && STALE_BUNDLE_ERROR_PATTERN.test(message);
}

function getRecoveryCopy(
  pathname: string,
  scope: "app" | "route",
): RecoveryCopy {
  if (scope === "app") {
    return {
      kicker: "Job Finder error",
      title: "Job Finder couldn't finish opening",
      description:
        "A screen failed while the workspace was loading. Reload the app to restore a stable session.",
    };
  }

  return {
    kicker: "Screen error",
    title: "This screen stopped responding",
    description:
      "Job Finder recovered the rest of the app. Reload to try this screen again, or move to a stable view.",
    secondaryAction: {
      label: "Open profile",
      path: "/job-finder/profile",
    },
  };
}

function getTechnicalDetails(error: unknown): string | null {
  if (isRouteErrorResponse(error)) {
    const responseLines = [
      `Route error: ${error.status} ${error.statusText}`,
      typeof error.data === "string" ? error.data : null,
    ].filter(Boolean);

    return responseLines.join("\n\n");
  }

  if (error instanceof Error) {
    return [error.name, error.message, error.stack]
      .filter(Boolean)
      .join("\n\n");
  }

  if (typeof error === "string") {
    return error;
  }

  return null;
}

export function JobFinderRouteErrorBoundary({
  scope,
}: JobFinderRouteErrorBoundaryProps) {
  const error = useRouteError();
  const location = useLocation();
  const navigate = useNavigate();
  const isStaleBundle = isStaleBundleError(error);
  const copy = isStaleBundle
    ? getStaleBundleRecoveryCopy(scope)
    : getRecoveryCopy(location.pathname, scope);
  const technicalDetails = getTechnicalDetails(error);
  const isInline = scope === "route";

  return (
    <main
      className={cn(
        "grid place-items-center px-4 py-6 sm:px-6",
        isInline ? "min-h-full" : "min-h-screen bg-canvas px-6 py-10",
      )}
    >
      <section
        className={cn(
          "w-full overflow-hidden rounded-(--workspace-state-card-radius) border shadow-(--workspace-state-card-shadow)",
          isStaleBundle
            ? "border-border/60 bg-(--workspace-state-card-bg-default)"
            : "border-destructive/22 bg-(--workspace-state-card-bg-error)",
          isInline
            ? "max-w-5xl rounded-(--radius-panel)"
            : "max-w-(--workspace-state-card-max-width)",
        )}
      >
        <span aria-atomic="true" aria-live="assertive" className="sr-only">
          {copy.title}
        </span>
        <div
          className={cn(
            "grid gap-0",
            isInline &&
              "lg:grid-cols-[minmax(0,1fr)_var(--workspace-state-card-aside-width-inline)]",
          )}
        >
          <div className="grid gap-6 p-6 sm:p-8 lg:p-10">
            <div
              className={cn(
                "inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-(length:--text-count) font-bold uppercase tracking-(--tracking-caps)",
                isStaleBundle
                  ? "border-primary/25 bg-primary/10 text-primary"
                  : "border-destructive/25 bg-destructive/10 text-destructive",
              )}
            >
              {isStaleBundle ? (
                <RefreshCcw className="size-3.5" />
              ) : (
                <AlertTriangle className="size-3.5" />
              )}
              <span>{copy.kicker}</span>
            </div>

            <div className="grid max-w-2xl gap-3">
              <h1 className="font-display text-(length:--workspace-state-title-size) font-semibold tracking-(--workspace-state-title-tracking) text-(--text-headline)">
                {copy.title}
              </h1>
              <p className="max-w-(--workspace-state-card-max-width) text-sm leading-7 text-foreground-soft sm:text-base">
                {copy.description}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                className="normal-case tracking-normal"
                onClick={() => window.location.reload()}
                type="button"
              >
                <RefreshCcw className="size-4" />
                Reload app
              </Button>
              {copy.secondaryAction ? (
                <Button
                  className="normal-case tracking-normal"
                  onClick={() => {
                    void navigate(copy.secondaryAction!.path, {
                      replace: true,
                    });
                  }}
                  type="button"
                  variant="outline"
                >
                  {copy.secondaryAction.path.includes("/review-queue") ? (
                    <ArrowLeft className="size-4" />
                  ) : (
                    <Home className="size-4" />
                  )}
                  {copy.secondaryAction.label}
                </Button>
              ) : null}
            </div>

            {technicalDetails && !isStaleBundle ? (
              <details className="group rounded-(--radius-field) border border-border/45 bg-background/45 p-4">
                <summary className="w-fit cursor-pointer list-none text-sm font-medium text-foreground underline decoration-from-font underline-offset-4 transition-colors group-open:text-foreground-soft">
                  Technical details
                </summary>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border/35 pt-3 text-xs leading-6 text-foreground-soft">
                  {technicalDetails}
                </pre>
              </details>
            ) : null}
          </div>

          {scope === "route" ? (
            <div className="border-t border-destructive/12 bg-(--workspace-state-card-bg-default) p-6 sm:p-8 lg:border-l lg:border-t-0 lg:p-10">
              <div className="grid gap-4">
                <p className="font-display text-(length:--text-count) font-bold uppercase tracking-(--tracking-caps) text-primary">
                  Recovery notes
                </p>
                <div className="grid gap-3 text-sm leading-6 text-foreground-soft">
                  {isStaleBundle ? (
                    <>
                      <p>
                        An app update replaced the files behind this screen
                        while it was open, so this route cannot load its old
                        bundle again.
                      </p>
                      <p>
                        Reload to pick up the current version, or use the
                        fallback action to move back to a stable screen first.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>
                        The exception was isolated to the current route, so you
                        do not have to restart the whole desktop shell unless
                        reload fails.
                      </p>
                      <p>
                        Use the fallback action to move back to a stable screen,
                        then reopen the workflow when you are ready.
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
