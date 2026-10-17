import type { InterviewDiagnosticEvent } from "@nestor/contracts";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

function getIcon(event: InterviewDiagnosticEvent) {
  if (event.severity === "error") {
    return <AlertTriangle className="mt-0.5 size-4 text-critical" />;
  }

  if (event.severity === "warning") {
    return <AlertTriangle className="mt-0.5 size-4 text-(--warning-text)" />;
  }

  if (event.kind === "lifecycle") {
    return <CheckCircle2 className="mt-0.5 size-4 text-(--success-text)" />;
  }

  return <Info className="mt-0.5 size-4 text-(--info-text)" />;
}

export function InterviewDiagnosticsPanel(props: {
  diagnostics: readonly InterviewDiagnosticEvent[];
}) {
  const diagnostics = props.diagnostics.slice(-8).reverse();

  return (
    <div className="grid gap-2">
      {diagnostics.length > 0 ? (
        diagnostics.map((event) => (
          <div
            className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3"
            key={event.id}
          >
            <div className="flex items-start gap-2">
              {getIcon(event)}
              <div className="min-w-0">
                <p className="text-[0.82rem]">{event.label}</p>
                <p className="mt-1 text-[0.7rem] uppercase tracking-(--tracking-badge) text-muted-foreground">
                  {event.kind} / {event.severity}
                </p>
                {event.detail ? (
                  <p className="mt-2 text-[0.74rem] leading-5 text-muted-foreground">
                    {event.detail}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ))
      ) : (
        <div className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3 text-[0.78rem] text-muted-foreground">
          No diagnostics recorded.
        </div>
      )}
    </div>
  );
}
