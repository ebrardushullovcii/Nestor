/**
 * Plain-language labels shared by guided setup and the full Profile editor.
 *
 * These fields intentionally keep legal work facts separate from search
 * preferences. Unknown legal facts stay Not set; the UI must not infer them
 * from a resume or from a preferred work mode.
 */
export const PROFILE_WORK_CONSTRAINT_COPY = {
  authorizedWorkCountries: {
    // R10: read as "where I would work from", so a remote preference became
    // a claim of US and UK work authorization on applications.
    description:
      "Only where your citizenship, permanent residence, visa or permit lets you work without sponsorship. Not where you would like to work, and not remote work from home, which is asked separately. Save limited permits in Profile under Work eligibility.",
    label: "Countries where you are legally allowed to work",
    placeholder: "Example: United States, Germany",
  },
  preferredRelocationRegions: {
    description: "A preference, not a work-authorization answer.",
    label: "Places you would consider relocating to",
    placeholder: "Example: Austin, TX; Berlin",
  },
  requiresVisaSponsorship: {
    description: "Yes only if an employer must sponsor you.",
    label: "Would you need employer visa sponsorship?",
  },
  remoteEligible: {
    description:
      "Whether the law lets you do a remote job from the country you live in, for an employer elsewhere. Not whether you prefer remote work.",
    label: "Can you legally work remotely from where you live?",
  },
  willingToRelocate: {
    description: "Whether you would move for a role.",
    label: "Would you relocate?",
  },
  willingToTravel: {
    description: "Whether you would travel for work.",
    label: "Would you travel for work?",
  },
  workModes: {
    // "Two things with the same name meaning different things": this
    // preference and a work-history card's "Work mode" were both called work
    // mode, and neither said hours. This one is about where you work.
    description:
      "Remote, hybrid, onsite, or flexible. Tick every one you would accept; hours are set under Hours.",
    label: "Where you want to work",
  },
} as const;
