import { useRef } from "react";
import { normalizePublicLinkUrl } from "@nestor/contracts";
import { Controller, type UseFormReturn } from "react-hook-form";
import { Checkbox } from "@renderer/components/ui/checkbox";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import { joinListInput, parseListInput } from "../../lib/job-finder-utils";

function linkDisplayName(
  link: ProfileEditorValues["links"][number],
  index: number,
): string {
  const label = link.label.trim();
  if (label) {
    return label;
  }

  return link.kind
    ? `${link.kind.charAt(0).toUpperCase()}${link.kind.slice(1)} link`
    : `Public link ${index + 1}`;
}

export function PreferredApplicationLinksField(props: {
  fieldId: string;
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const syntheticIds = useRef(new Set<string>());
  const savedLinks = props.profileForm.watch("links");
  const persistedLinks = props.profileForm.formState.defaultValues?.links ?? [];
  const website = props.profileForm.watch("identity.personalWebsiteUrl");
  const portfolio = props.profileForm.watch("identity.portfolioUrl");
  const links = [...savedLinks];
  for (const [label, kind, url] of [
    ["Website", "website", website],
    ["Portfolio", "portfolio", portfolio],
  ] as const) {
    const normalizedUrl = normalizePublicLinkUrl(url);
    if (
      url.trim() &&
      !links.some((link) => normalizePublicLinkUrl(link.url) === normalizedUrl)
    ) {
      const baseId = `contact_${kind}`;
      let id = baseId;
      for (let suffix = 1; links.some((link) => link.id === id); suffix += 1) {
        id = `${baseId}_${suffix}`;
      }
      links.push({ id, label, kind, url: normalizedUrl });
    }
  }

  return (
    <Controller
      control={props.profileForm.control}
      name="applicationIdentity.preferredLinkIds"
      render={({ field }) => {
        const selectedIds = new Set(parseListInput(field.value));

        return (
          <fieldset
            className="grid min-w-0 gap-3 md:col-span-2"
            id={props.fieldId}
          >
            <legend className="text-sm font-medium text-foreground">
              Links to include on applications
            </legend>
            <p className="text-sm leading-6 text-foreground-soft">
              Choose a saved Website, Portfolio, or public link to include on
              applications.
            </p>
            {links.length > 0 ? (
              <div className="grid gap-2">
                {links.map((link, index) => {
                  const checkboxId = `${props.fieldId}-${link.id}`;
                  const checked = selectedIds.has(link.id);

                  return (
                    <label
                      className="flex cursor-pointer items-start gap-3 rounded-(--radius-field) border border-border/35 bg-background/55 p-3"
                      htmlFor={checkboxId}
                      key={link.id}
                    >
                      <Checkbox
                        checked={checked}
                        id={checkboxId}
                        onCheckedChange={(nextChecked) => {
                          const nextIds = new Set(selectedIds);
                          if (nextChecked === true) {
                            if (
                              !savedLinks.some((saved) => saved.id === link.id)
                            ) {
                              syntheticIds.current.add(link.id);
                              props.profileForm.setValue(
                                "links",
                                [...savedLinks, link],
                                { shouldDirty: true },
                              );
                            }
                            nextIds.add(link.id);
                          } else {
                            nextIds.delete(link.id);
                            if (
                              syntheticIds.current.has(link.id) &&
                              !persistedLinks.some(
                                (saved) => saved?.id === link.id,
                              )
                            ) {
                              props.profileForm.setValue(
                                "links",
                                savedLinks.filter(
                                  (saved) => saved.id !== link.id,
                                ),
                                { shouldDirty: true },
                              );
                              syntheticIds.current.delete(link.id);
                            }
                          }
                          field.onChange(joinListInput([...nextIds]));
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foreground">
                          {linkDisplayName(link, index)}
                        </span>
                        <span className="block break-all text-sm leading-6 text-foreground-soft">
                          {link.url.trim() ||
                            "Add this link’s URL in Background before selecting it."}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-(--radius-field) border border-dashed border-border/45 p-3 text-sm leading-6 text-foreground-soft">
                No public links are saved yet. Add LinkedIn, a portfolio, or
                another profile in Background first.
              </p>
            )}
          </fieldset>
        );
      }}
    />
  );
}
