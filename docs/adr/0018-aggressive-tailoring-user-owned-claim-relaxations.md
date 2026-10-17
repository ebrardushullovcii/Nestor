# ADR 0018: Aggressive tailoring may round years up by one and name listing technologies, at the user's own risk

Status: accepted (2026-09-06). Amended by ADR 0041 (2026-10-03): the model's fact check, not the rule classifier, now decides what is a stretch; listing technologies are no longer added to the skills section by code. The intent stands: in aggressive mode a small stretch is the person's call and goes to them to confirm. Amended by ADR 0051 (2026-10-17): choosing Aggressive is that call; stretches are no longer confirmed line by line.

## Context

Aggressive tailoring was designed fail-closed (ADR-era grounding policy in `resume-generation-grounding.ts`): every metric had to appear verbatim in the cited evidence, every named word had to come from the evidence, and the fail-closed lexical policy rejected any unknown token. The candidate — the product's only user, editing their own resume — asked for two deliberate exceptions, because an exact-evidence resume can undersell a real practitioner:

- "I have worked with TypeScript 3, close to 4 years, and the job asks for 4" — the truthful figure is a rounding step away from the requirement.
- "The job names a library I never wrote down, but with my evidenced experience I would have used it or know how to use it" — the interview is where the claim gets proven.

Silently accepting either would break the product's grounding promise; refusing both makes aggressive mode materially weaker than the candidate wants. The middle path already exists in the verifier: `confirm_needed` claim assessments block export until the user confirms each claim with the ownership statement "I confirm this content is accurate and my own."

## Decision

In aggressive tailoring only, on lines the model itself flags `inferred` (so they are counted in the draft notes), the deterministic gate accepts two bounded relaxations and reports both through the existing user-confirmation flow:

- **Years rounding.** A years-of-experience figure may be stated one year above the cited evidence, but only when the target listing itself states that higher years figure (evidenced "3 years" may be stated as listed "4 years"). The metric must be a pure integer in a years context; percentages, money, and counts stay verbatim-evidence-required in every mode.
- **Listing-anchored technologies.** A named technology may come from the target job listing's own text (description, responsibilities, qualifications, key skills) — never from nowhere. For a candidate whose saved evidence shows professional technical experience, the model adds any technology the listing asks for (required or preferred), without requiring the evidenced stack to imply it; the gate cannot judge plausibility, so its bound is "the listing itself asked for it". The same bound applies to the skills section: in aggressive mode the job's requested technologies are deterministically added to core skills (from `job.keySkills` and any skill the listing text names), named in a note, and kept by the workspace sanitizer so they reach the exported resume.

Everything else stays hard in every mode: the target employer, dates, titles, credentials, seniority, leadership, and every non-years number still require evidence, and a technology absent from both the evidence and the listing still rejects.

The workspace verifier runs the same relaxations in its most-permissive posture so accepted claims never flip to unsupported after acceptance, and maps every relaxed claim to `confirm_needed` (generated lines) or informational `review` (user-authored prose). The draft note states plainly that relaxed lines go beyond saved evidence and that confirming them is the user's responsibility. The user owns the honesty decision; the product never presents a relaxed claim as verified.

The product copy states the purpose of these relaxations plainly rather than euphemizing it: relaxed lines are small, deliberate claims aimed at clearing the job's screening and earning the first interview, bounded to what the candidate's evidence implies they can actually do, with proof deferred to the interview — which only the candidate can provide. Every surface where relaxed lines appear (draft notes, per-claim confirmations, guided-setup copy) says this, and the confirmation gate keeps the candidate's ownership explicit. The copy deliberately avoids accusing or moralizing language; it states the purpose, the bounds, and whose call it is.

## Consequences

- Relaxed lines are counted in the `AI-inferred … came from aggressive tailoring` note, which now names both relaxations and the user-owned confirmation duty.
- The verifier's legacy quantified-claim scan applies the same one-year adjacency (anchored on the years unit, without token-overlap), so rounded claims surface as confirmations instead of `invented_metric` errors; the claim-evidence bank now includes the profile's own years-of-experience figure.
- Conservative and balanced drafts are unchanged: the generation gate only relaxes under aggressive mode plus the model's inferred flag. User-authored prose that matches a relaxation lands in informational review, matching the verifier's existing permissive posture.
- A future reader of the fail-closed lexical policy should not "fix" the listing-unit exception: it is the intended bound of this decision, and the safe-vocabulary list itself stays closed to technologies.

Rejected alternatives: a curated technology-adjacency map (brittle, maintenance-heavy, and still cannot judge "would have used it"); letting the gate accept any metric within a tolerance (unbounded beyond years); relaxing only the prompt and keeping the gate strict (the gate would reject every relaxed line, so nothing would change).
