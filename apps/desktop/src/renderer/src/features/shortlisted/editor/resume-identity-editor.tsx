import type { ResumeDraftIdentity } from "@nestor/contracts";
import { getResumeIdentityTargetId } from "@nestor/contracts";
import { ChevronDown } from "lucide-react";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { useEffect, useRef, useState } from "react";

// Keep exactly what the person typed while they type: a trailing space is the
// separator before the next word. Fields are trimmed when they lose focus.
function normalizeNullableText(value: string): string | null {
  return value.trim().length > 0 ? value : null;
}

function trimNullableText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

type IdentityTextField = Exclude<keyof ResumeDraftIdentity, "additionalLinks">;

function normalizeLinkList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

interface ResumeIdentityEditorProps {
  disabled: boolean;
  identity: ResumeDraftIdentity | null;
  onChange: (identity: ResumeDraftIdentity) => void;
  selectedTargetId: string | null;
}

export function ResumeIdentityEditor(props: ResumeIdentityEditorProps) {
  const containerRef = useRef<HTMLDetailsElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const identity = props.identity ?? {
    fullName: null,
    headline: null,
    location: null,
    email: null,
    phone: null,
    portfolioUrl: null,
    linkedinUrl: null,
    githubUrl: null,
    personalWebsiteUrl: null,
    additionalLinks: [],
  };

  const updateIdentity = (patch: Partial<ResumeDraftIdentity>) => {
    props.onChange({
      ...identity,
      ...patch,
    });
  };

  const targetProps = (targetId: string) => ({
    "data-resume-editor-target": targetId,
  });

  const trimOnBlur = (field: IdentityTextField) => () => {
    const value = identity[field];
    const trimmed = trimNullableText(value);
    if (trimmed !== value) {
      updateIdentity({ [field]: trimmed });
    }
  };

  // The links box keeps its own text so Enter can start a new line before the
  // next link is typed; the saved list drops blank lines.
  const [linksText, setLinksText] = useState(() =>
    identity.additionalLinks.join("\n"),
  );
  const savedLinksKey = identity.additionalLinks.join("\n");
  useEffect(() => {
    setLinksText((current) =>
      normalizeLinkList(current).join("\n") === savedLinksKey
        ? current
        : savedLinksKey,
    );
  }, [savedLinksKey]);

  useEffect(() => {
    if (!props.selectedTargetId?.startsWith("identity:")) {
      return;
    }

    setIsOpen(true);

    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const target = container.querySelector<HTMLElement>(
        `[data-resume-editor-target="${props.selectedTargetId}"]`,
      );

      if (!target) {
        return;
      }

      target.focus({ preventScroll: true });

      const scrollRegion =
        container.closest<HTMLElement>(
          "[data-resume-workspace-scroll-region]",
        ) ??
        container.closest<HTMLElement>("[data-resume-editor-scroll-region]") ??
        container.closest<HTMLElement>("[data-resume-preview-scroll-region]");
      if (!scrollRegion) {
        return;
      }

      const regionTop = scrollRegion.scrollTop;
      const regionBottom = regionTop + scrollRegion.clientHeight;
      const regionRect = scrollRegion.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetTop =
        scrollRegion.scrollTop + targetRect.top - regionRect.top;
      const targetBottom = targetTop + targetRect.height;

      if (targetTop < regionTop) {
        scrollRegion.scrollTop = Math.max(0, targetTop - 24);
        return;
      }

      if (targetBottom > regionBottom) {
        scrollRegion.scrollTop = targetBottom - scrollRegion.clientHeight + 24;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [props.selectedTargetId]);

  return (
    <details
      className="surface-card-tint group min-w-0 rounded-(--radius-field) border border-(--surface-panel-border)"
      data-resume-identity-details
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      open={isOpen}
      ref={containerRef}
      tabIndex={-1}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-(--radius-field) px-3 py-2 outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid min-w-0 gap-0.5">
          <h3 className="font-display text-(--text-headline)">
            Resume identity
          </h3>
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            Header content shown at the top of the preview and export.
          </p>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>

      <div className="grid min-w-0 gap-3 p-3 pt-0">
        <Field>
          <FieldLabel htmlFor="resume_identity_full_name">Full name</FieldLabel>
          <Input
            id="resume_identity_full_name"
            {...targetProps(getResumeIdentityTargetId("fullName"))}
            disabled={props.disabled}
            value={identity.fullName ?? ""}
            onBlur={trimOnBlur("fullName")}
            onChange={(event) =>
              updateIdentity({
                fullName: normalizeNullableText(event.currentTarget.value),
              })
            }
          />
        </Field>

        <div className="grid gap-3 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="resume_identity_headline">Headline</FieldLabel>
            <Input
              id="resume_identity_headline"
              {...targetProps(getResumeIdentityTargetId("headline"))}
              disabled={props.disabled}
              value={identity.headline ?? ""}
              onBlur={trimOnBlur("headline")}
              onChange={(event) =>
                updateIdentity({
                  headline: normalizeNullableText(event.currentTarget.value),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="resume_identity_location">Location</FieldLabel>
            <Input
              id="resume_identity_location"
              {...targetProps(getResumeIdentityTargetId("location"))}
              disabled={props.disabled}
              value={identity.location ?? ""}
              onBlur={trimOnBlur("location")}
              onChange={(event) =>
                updateIdentity({
                  location: normalizeNullableText(event.currentTarget.value),
                })
              }
            />
          </Field>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="resume_identity_email">Email</FieldLabel>
            <Input
              id="resume_identity_email"
              {...targetProps(getResumeIdentityTargetId("email"))}
              disabled={props.disabled}
              value={identity.email ?? ""}
              onBlur={trimOnBlur("email")}
              onChange={(event) =>
                updateIdentity({
                  email: normalizeNullableText(event.currentTarget.value),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="resume_identity_phone">Phone</FieldLabel>
            <Input
              id="resume_identity_phone"
              {...targetProps(getResumeIdentityTargetId("phone"))}
              disabled={props.disabled}
              value={identity.phone ?? ""}
              onBlur={trimOnBlur("phone")}
              onChange={(event) =>
                updateIdentity({
                  phone: normalizeNullableText(event.currentTarget.value),
                })
              }
            />
          </Field>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="resume_identity_portfolio">
              Portfolio URL
            </FieldLabel>
            <Input
              id="resume_identity_portfolio"
              {...targetProps(getResumeIdentityTargetId("portfolioUrl"))}
              disabled={props.disabled}
              value={identity.portfolioUrl ?? ""}
              onBlur={trimOnBlur("portfolioUrl")}
              onChange={(event) =>
                updateIdentity({
                  portfolioUrl: normalizeNullableText(
                    event.currentTarget.value,
                  ),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="resume_identity_linkedin">
              LinkedIn URL
            </FieldLabel>
            <Input
              id="resume_identity_linkedin"
              {...targetProps(getResumeIdentityTargetId("linkedinUrl"))}
              disabled={props.disabled}
              value={identity.linkedinUrl ?? ""}
              onBlur={trimOnBlur("linkedinUrl")}
              onChange={(event) =>
                updateIdentity({
                  linkedinUrl: normalizeNullableText(event.currentTarget.value),
                })
              }
            />
          </Field>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="resume_identity_github">GitHub URL</FieldLabel>
            <Input
              id="resume_identity_github"
              {...targetProps(getResumeIdentityTargetId("githubUrl"))}
              disabled={props.disabled}
              value={identity.githubUrl ?? ""}
              onBlur={trimOnBlur("githubUrl")}
              onChange={(event) =>
                updateIdentity({
                  githubUrl: normalizeNullableText(event.currentTarget.value),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="resume_identity_website">
              Personal website URL
            </FieldLabel>
            <Input
              id="resume_identity_website"
              {...targetProps(getResumeIdentityTargetId("personalWebsiteUrl"))}
              disabled={props.disabled}
              value={identity.personalWebsiteUrl ?? ""}
              onBlur={trimOnBlur("personalWebsiteUrl")}
              onChange={(event) =>
                updateIdentity({
                  personalWebsiteUrl: normalizeNullableText(
                    event.currentTarget.value,
                  ),
                })
              }
            />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="resume_identity_additional_links">
            Additional links
          </FieldLabel>
          <Textarea
            className="min-h-28"
            id="resume_identity_additional_links"
            {...targetProps(getResumeIdentityTargetId("additionalLinks"))}
            disabled={props.disabled}
            rows={4}
            value={linksText}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setLinksText(text);
              updateIdentity({ additionalLinks: normalizeLinkList(text) });
            }}
          />
        </Field>
      </div>
    </details>
  );
}
