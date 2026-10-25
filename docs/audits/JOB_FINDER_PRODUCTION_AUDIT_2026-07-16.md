# Job Finder Production Audit — 2026-07-16

## Scope and safety

- Fresh Windows desktop profile, production build, operated manually through Computer Use.
- Auditor posture: first-time customer with no repository or documentation context.
- In scope: Job Finder onboarding, resume import/profile, discovery setup and speed, result quality, shortlisting, resume choice, and safe application preparation.
- Out of scope: Interview Helper changes and every final job-application submission control.
- Safety invariant: no final Apply/Submit control may be activated and no real user profile may be submitted.

## Evidence convention

Evidence is captured from the actual desktop window during this task. Each `CU-BEFORE-*` or `CU-AFTER-*` label refers to the corresponding Computer Use screenshot displayed in the task transcript. Fixes must include a matching after-state capture before they can be marked verified.

Durable screenshots from the final fresh-build pass are stored in `docs/audits/evidence/job-finder-2026-07-16-final/`:

- `01-fresh-launch.png` — fresh Job Finder launch with neutral pre-analysis states.
- `02-resume-import-start.png` — real import progress state. The Windows file picker could not be completed through Computer Use, so this is not evidence that extraction failed.
- `03-discovery-ready.png` — real Circle Greenhouse result after a roughly 2.1 second rerun.
- `04-original-cv-review.png` and `05-apply-copilot-ready.png` — unchanged original CV, sensitive-data warning, and guarded apply action.
- `06-greenhouse-filled-form.png` — exact identity fields, `+383`, phone digits, and `Ebrar.pdf` on the real provider form.
- `07-greenhouse-final-submit-untouched.png` — the real final `Submit application` control visible and untouched. The provider country selector was open during proof capture; no final action was activated.
- `08-applications-manual-review-blocker.png` — latest honest app verdict after the provider-widget persistence check.

## Current journey health

| Journey stage | Evidence-backed state |
| --- | --- |
| Fresh launch | Pass: Job Finder opens first and empty analysis uses neutral language. |
| Resume extraction | Automated pipeline and progress tests pass; native-picker completion was not reproducible through Computer Use in the final fresh profile. Previously imported real PDF preserved all nine roles and the exact original file. |
| Real-source discovery | Pass for the tested Circle Greenhouse source: exact listing, URL, provider, date, remote label, and evidence ledger; latest rerun completed in about 2.1 seconds. |
| Original-CV mode | Pass: setting persists, current shortlist updates, exact imported file is reviewed and attached without rewriting. |
| Application preparation | Partial: real form visibly contains the grounded identity, phone, LinkedIn, and original PDF and final submit remains untouched, but the app still reports the phone widget as unpersisted. |
| Sellable production readiness | Fail: the remaining provider-widget false negative and incomplete fresh native-picker replay are release blockers. |

## Journey log and findings

### Step 1 — Fresh launch and Job Finder entry

Evidence: `CU-BEFORE-01`, fresh launch; `CU-BEFORE-02`, first Job Finder screen.

1. **P0 — The product launches into Interview Helper instead of Job Finder.** A customer buying the job-search product sees an unrelated setup screen first and must notice a small mode switch in the title bar. Job Finder should be the fresh-install/default landing surface, or the app should present a clear product chooser.
2. **P1 — First-run status messaging contradicts itself.** The setup is labeled `NOT STARTED`, while the right panel says the current Import step “is in good shape right now.” No resume exists, so this reassurance is false and makes the state model feel unreliable.
3. **P1 — The app presents negative quality diagnoses before it has evidence.** `Needs targeting details`, `Needs stronger work history`, and `Missing contact details` appear before import. Use neutral “Not provided yet” or hide quality judgments until analysis exists.
4. **P2 — The first screen is visually heavy for a one-action state.** Large empty panels, a below-the-fold setup path, and a persistent review queue compete with the obvious first task. The primary action is understandable, but the screen should focus on importing or starting manually.
5. **P2 — Profile Copilot overlaps the lower-right review panel.** The floating control covers content in a dense layout and reduces confidence that the page was intentionally composed.

### Step 2 — Resume import and profile review

Evidence: `CU-BEFORE-03`, import in progress; `CU-BEFORE-04`, imported Background review; `CU-BEFORE-05`, unresolved readiness check.

6. **P0 — Resume import took 133 seconds with no progress feedback.** Both import controls became disabled while the page otherwise looked unchanged. A customer cannot tell whether extraction is working, frozen, or safe to retry. Show named stages, elapsed progress, and a recovery action; separately profile and reduce the extraction latency. **Implemented, awaiting Computer Use replay:** import now reports typed, real pipeline stages (local copy, document/layout reading, grounded profile suggestion analysis, saving results) through request-scoped IPC, shows exact elapsed time on both guided setup and full Profile, and explains after 45 seconds that larger/image-heavy files can take a couple of minutes. Retry remains the safe recovery path; cancellation is not shown because the current analysis runtime cannot guarantee rollback. Review confirmed document extraction and vision generation already run concurrently, as do independent analysis stages, so no quality-reducing latency shortcut was introduced.
7. **P1 — The strongest CTA still asks to import after import succeeds.** The bright `IMPORT OR REFRESH RESUME` action remains more prominent than reviewing the current step, encouraging unnecessary repeat work.
8. **P1 — `REVIEW CURRENT STEP` does not visibly move the customer to the review content.** The viewport remains at the page top and there is no clear transition, so the action appears broken until the user manually scrolls.
9. **P1 — Review cards expose raw JSON.** Education and language suggestions render serialized internal objects instead of customer-readable summaries.
10. **P1 — Imported work-history content is not résumé-ready.** The newest role overview repeats achievement bullets, combines two projects into one dense paragraph, and contains fused/truncated phrases. Nine roles were preserved, which is good, but the writing needs de-duplication, structure, and evidence-grounded editing rather than wholesale role deletion.
11. **P1 — A confirmed education record still creates four critical field blockers.** Confirming the imported education card does not resolve Degree, Field of Study, School Name, and Location. The Ready check reports six blockers without naming them, even though the current-step queue says nothing is unresolved. This is duplicate review work and an internally contradictory completion state.
12. **P1 — Step badges regress to `NEEDS REVIEW` after apparently resolved work.** Essentials and Background can look complete, then return to review state later without explaining what changed.
13. **P2 — The two-column review layout contains competing scroll regions and clipped actions.** Long profile forms, a separately scrolling queue, and the Copilot overlay make navigation unpredictable; `Dismiss for now` was visibly clipped.

### Step 3 — Targeting, narrative, and reusable answers

Evidence: `CU-BEFORE-06`, targeting suggestion; `CU-BEFORE-07`, narrative; `CU-BEFORE-08`, reusable answers.

14. **P1 — The importer treats a home address as a preferred job location without explicit consent.** `Prishtina, Kosovo` was recommended as a search preference solely because it appeared on the résumé. Home location and desired search geography are different concepts.
15. **P1 — A single comma-separated location becomes two chips.** Confirming `Prishtina, Kosovo` creates separate `Prishtina` and `Kosovo` preferences, changing the meaning and broadening discovery unexpectedly.
16. **P1 — Targeting is called “in good shape” while important controls are unset.** Preferred work mode and remote eligibility remain blank even though imported roles include remote work. The distinction between `Remote eligible` and a `Remote` preferred-work-mode checkbox is not explained.
17. **P1 — The recommended professional summary is generic and awkward.** It uses unsupported-sounding superlatives and clichés (`passionate`, `impactful`, `true passion`), malformed punctuation (`Node.js,.NET`), and awkward grammar (`management, and`). Recommending it as-is damages trust in generated résumé quality.
18. **P1 — Customer forms expose opaque public-link IDs.** The reusable-answers form displays an identifier such as `link_linkedin_https_www_linkedin...` instead of the human label and URL.
19. **P1 — Narrative data is duplicated inconsistently.** The short self-introduction repeats the weak imported summary, while the career-transition answer remains blank despite a transition summary already existing in Narrative.
20. **P2 — Proof-bank cards claim details are missing when they are populated.** Collapsed cards show `Add the claim and strongest supporting detail` even when a claim and context are present.

### Step 4 — Readiness explanation

Evidence: `CU-BEFORE-09`, Ready check with six blockers; `CU-BEFORE-10`, Essentials queue; `CU-BEFORE-11`, Background queue.

21. **P1 — The Ready check hides the identity of its blockers.** It reports six blocking items but the adjacent current-step queue says there are none. The customer must manually reopen every prior step to discover two Essentials confirmations and four duplicate education-field confirmations.
22. **P2 — Readiness language is too vague to be actionable.** “Discovery can still drift” and “repeated screeners will still need extra input” do not name the fields to fix or provide a direct action.

### Step 5 — Real-source setup and discovery

Evidence: `CU-BEFORE-12`, zero-source Find Jobs state; `CU-BEFORE-13`, buried source editor; `CU-BEFORE-14`, Copilot covering Save; `CU-BEFORE-15`, real Circle Greenhouse result.

23. **P0 — A fresh customer reaches Find Jobs with zero usable sources and cannot search.** The page disables discovery and says to choose a source, but provides no starter source, recommended source, or inline Add Source action. The product's core promise is blocked until the customer discovers a separate configuration flow.
24. **P1 — `Edit search in Profile` does not take the customer to the setting that blocks search.** It opens the top of the full Profile page. Reaching Job sources requires scrolling through the entire profile, choosing Preferences, then scrolling a second nested pane to its bottom. Deep-link directly to the missing or requested search field.
25. **P1 — Confirmed onboarding data reappears as unresolved import noise in full Profile.** The full editor again showed eight suggestions and twelve warnings after the guided flow had already confirmed key records. The two profile surfaces do not feel like the same saved state.
26. **P0 — Profile Copilot can cover the primary `Save changes` action.** At the bottom of Preferences, the collapsed bubble sat over the save control; expanding it covered the source form and right side of the page. A customer can configure a real source and then be unable to tell how to persist it.
27. **P2 — Source setup assumes technical knowledge.** A first-time customer must invent a source name and know a valid careers-board root URL. The page offers no examples, supported-provider presets, URL validation guidance, or a paste-any-job-link path.
28. **P1 — Discovery controls are hidden inside a narrow independently scrolling sidebar.** Opening the dedicated browser leaves Search jobs and per-source controls below the fold in a small pane, while the main results area initially reports no matches. The primary search action should remain visible.
29. **P1 — Opening the dedicated browser briefly looks like a failed search.** The app moves from `Browser is starting` to `No matches from this search` before the customer has clearly run a search. Browser readiness and search-result emptiness need separate states.
30. **P0 — Real Greenhouse discovery is fast and exact, but the first-run setup cost dominates it.** Once configured, the Circle source returned the current `Senior Full-Stack Software Engineer, Applied AI` listing in about 1.3 seconds with the correct title, company, remote label, date, provider, and application URL. The discovery engine's happy path is strong; onboarding and source setup prevent customers from reaching it.
31. **P1 — Match evidence contains contradictory and noisy claims.** The evidence ledger marked remote work as supported while saying remote-work eligibility was not confirmed, rendered `Remote; remote`, and surfaced a `United States` geography hint for a globally benchmarked remote role. A 90% score needs consistent blocker/uncertainty handling.
32. **P2 — Job details expose provider implementation internals.** `Board token`, preferred API method, method order, and best start route are useful diagnostics but not customer decision support. Put them behind a diagnostics disclosure or developer mode.

### Step 6 — Shortlist and original-CV mode

Evidence: `CU-BEFORE-16`, tailored-resume-only shortlist; `CU-BEFORE-17`, original-CV setting; `CU-BEFORE-18`, setting still shown as tailored after Save.

33. **P0 — The original-CV setting does not persist through the visible workflow.** Selecting `Use my original CV unchanged`, scrolling to the distant Save Settings button, and saving still left `Tailor a CV for each job` labeled as the current default. Returning to Shortlisted continued to require a tailored résumé. This directly breaks the requested no-rewrite flow.
34. **P1 — Settings changes are easy to lose because Save is several screens below the choice.** The CV-mode cards give immediate selected styling but no sticky unsaved-state bar or nearby Save action. The customer can reasonably navigate away believing the change was applied.
35. **P1 — Existing shortlisted jobs give no explanation when a new CV default will not affect them.** The settings page says future application steps use the mode, but the Shortlisted page continues to demand tailoring without explaining whether the job captured an earlier mode or how to switch that job to the original CV.

Implementation verification: Settings now distinguishes the selected value from the persisted default, places `Save CV preference` beside the mode cards, reports unsaved and saved state, and states that the mode applies to current and future shortlisted jobs. Shortlist cards disclose `Original CV unchanged` or `Job-specific tailored CV`; original mode shows the chosen file name, import time, and a clearly labeled read-only text preview, and no longer offers the tailored-resume workspace action. Automated proof: desktop lint passed; 6 focused renderer tests passed; Job Finder lint passed; all 99 workspace-service core tests passed, including persistence across the repository, immediate review-queue recalculation, unchanged original-upload attachment, and the final-review pause.

### Step 7 — Real Greenhouse application preparation (final submit untouched)

Evidence: `CU-AFTER-01`, exact original CV shown for the shortlisted job; `CU-BEFORE-19`, populated Greenhouse identity fields; `CU-BEFORE-20`, blocked CV upload; `CU-BEFORE-21`, visible untouched Submit application control; `CU-BEFORE-22`, Applications safe-stop report.

36. **P1 — Original-CV review shows highly sensitive fields without a focused warning.** The exact extracted text includes date of birth, nationality, phone number, email, and home address. Byte-for-byte preservation is correct, but the decision screen should call out sensitive fields before the customer authorizes an external attachment.
37. **P0 — Prepare-only mode cannot complete the promised pre-submit state because it blocks the résumé upload.** The agent filled identity fields and reached the final Greenhouse screen in about 25 seconds, but the page showed `Prepare-only mode blocked a mutating XMLHttpRequest` under Resume/CV and no file was attached. The safety model needs a granular mode that permits form filling and the customer-approved CV upload while continuing to make final submission impossible.
38. **P1 — Confirmed profile links were not reused on the real form.** LinkedIn Profile remained blank even though the guided profile had confirmed a LinkedIn URL and the role exposes a matching field.
39. **P1 — Phone-country handling looks duplicated.** Greenhouse selected country code `+383` while the Phone field also contained `(+383) 44555010`. Normalize provider-specific country-code controls so the customer does not risk submitting the prefix twice.
40. **P1 — The Applications recovery message describes transport mechanics, not the customer task.** `blocked a POST xhr attempt` and `mutating page action` do not say that résumé attachment failed. Report the exact field/action, what was safely completed, what remains, and provide a direct Resume/CV recovery action.
41. **P2 — `Prepare interview` appears before the application is complete.** The prominent cross-product action competes with the only relevant next step—finishing this application—and is especially confusing in a `Needs action` state.
42. **Verified safety baseline — Final submission was not activated.** The real Greenhouse `Submit application` control remained visible and untouched. The run stopped in Applications with one Needs action item and no Submitted item.

After-fix Computer replay: `CU-AFTER-02`, saved original-CV default; `CU-AFTER-03`, original file name, sensitive-data warning, and read-only preview; `CU-AFTER-04`, browser-starting state with prior results retained; `CU-AFTER-05`, remote eligibility rendered as `UNKNOWN` with deduplicated `Remote` evidence; `CU-AFTER-06`, Applications paused at final pre-submit checkpoint; `CU-AFTER-07`, exact original PDF attached and LinkedIn populated; `CU-AFTER-08`, visible untouched Greenhouse `Submit application` control.

43. **P1 — Original-CV consent history uses tailored-resume language.** The successful original-file replay says `Use the approved tailored resume` even though the attached artifact is the unchanged original. Consent history must identify the artifact customers actually approved.
44. **P2 — The ATS sees the internal stored filename rather than the imported filename.** Greenhouse displays a timestamp-prefixed storage name instead of `Ebrar.pdf`. The bytes are correct, but internal storage details should not leak into a customer-facing application.
45. **P1 — The primary Apply Copilot action is buried below the evidence ledger.** On the real role, the customer had to drag or scroll the independently scrolling right pane to its bottom before the main action appeared. Keep the primary action in a fixed panel footer while the checklist, evidence, and secondary actions remain scrollable.
46. **P0 — A passive reCAPTCHA badge is mistaken for an active human-verification challenge.** On a fresh replay the Circle listing showed only the normal reCAPTCHA privacy badge, but Apply Copilot stopped before opening the form and asked the customer to complete a challenge that did not exist. Block only on visible page-level challenge language, not provider iframe metadata.
47. **P0 — Application readiness was previously based on attempted fills rather than the visible handoff state.** A replay logged First Name and Phone as answered even after the controlled Greenhouse form cleared them. The runtime must settle, re-inspect, retry safe exact values, and stop for review if the visible values do not persist. The final live replay also exposed provider-specific phone-country behavior: the calling-code control and phone input update asynchronously and need a longer stabilization window.
48. **P1 — A listing-level `Apply` action was treated as the final submission action.** On Greenhouse the first Apply control merely opens the application form. It is safe to advance; only the later Submit application control is final. The runtime now distinguishes those stages and has a focused regression test.

## Fix tracker

| ID | Status | Owner | Verification |
| --- | --- | --- | --- |
| P0-01 default Job Finder landing | verified by Computer replay | onboarding_profile_ux | rebuilt desktop launches directly into Job Finder |
| P1-02 truthful first-run step state | implemented, awaiting CU replay | onboarding_profile_ux | first run now invites import/manual entry instead of claiming the empty step is healthy |
| P1-03 neutral pre-analysis readiness labels | implemented, awaiting CU replay | onboarding_profile_ux | pre-analysis cards use Not provided yet / Not analyzed yet; covered by focused UI test |
| P2-04 simplify first-run hierarchy | open | unassigned | pending |
| P2-05 prevent Copilot overlap | implemented, awaiting CU replay | onboarding_profile_ux | collapsed Copilot now honors the same content-safe bottom offset as the expanded panel |
| P0-06 import progress and latency | implemented | resume-import production agent | Computer Use replay pending; focused and full automated checks passed |
| P1-07 post-import CTA hierarchy | implemented, awaiting CU replay | onboarding_profile_ux | successful import promotes Review and demotes Replace resume; covered by focused UI test |
| P1-08 review CTA navigation | implemented, awaiting CU replay | onboarding_profile_ux | review/open action scrolls and focuses the current review queue or step editor |
| P1-09 human-readable review values | implemented, awaiting CU replay | onboarding_profile_ux | structured education/language values are parsed, labeled, and stripped of internal ids; covered by unit tests |
| P1-10 résumé content quality | open | unassigned | pending |
| P1-11 duplicate education blockers | implemented, awaiting CU replay | profile_quality_cleanup | complete education records now subsume covered scalar field candidates, including after record confirmation; 2 focused Job Finder tests pass |
| P1-12 stable step status | implemented and automated-verified | profile_quality | step status/counts are derived from one stable review model; 13 focused customer-quality tests pass |
| P2-13 review layout and scroll | open | unassigned | pending |
| P1-14 separate home and preferred location | implemented and automated-verified | profile_quality | current/home location is presented separately from explicitly chosen search geography |
| P1-15 preserve compound locations | implemented and automated-verified | profile_quality | compound-location guidance no longer silently turns a city-country pair into unrelated intent |
| P1-16 honest targeting readiness | implemented and automated-verified | profile_quality | preferred work mode and remote-work eligibility are distinct readiness inputs with explicit unknown states |
| P1-17 professional summary quality | open | unassigned | pending |
| P1-18 hide internal link IDs | implemented, awaiting CU replay | profile_quality_cleanup | guided setup and full Profile now present labeled public-link choices with URLs; internal IDs remain persistence-only; focused renderer test passes |
| P1-19 reuse narrative consistently | implemented and automated-verified | profile_quality | existing transition narrative can populate the reusable answer instead of asking for duplicate prose |
| P2-20 accurate proof-bank summaries | implemented, awaiting CU replay | profile_quality_cleanup | collapsed proof cards fall back to their populated claim or context instead of a false missing-detail prompt |
| P1-21 reveal and link readiness blockers | implemented, awaiting CU replay | profile_quality_cleanup | Ready check lists each blocking item with its reason and a direct button to the owning setup step; focused renderer test passes |
| P2-22 actionable readiness language | implemented, awaiting CU replay | profile_quality_cleanup | discovery and application readiness copy now names the concrete categories to add or review instead of describing vague downstream drift |
| P0-23 usable first-run discovery source | implemented, awaiting CU replay | discovery_ux | zero-source recovery now offers a primary Add a job source action without inventing proprietary defaults |
| P1-24 deep-link search editing | implemented, awaiting CU replay | discovery_ux | source links open Preferences and focus Job sources directly |
| P1-25 reconcile guided and full-profile state | open | unassigned | pending |
| P0-26 keep Copilot clear of primary actions | implemented, awaiting CU replay | onboarding_profile_ux | collapsed Profile and Setup Copilot controls are raised above persistent action footers |
| P2-27 customer-friendly source setup | implemented, awaiting CU replay | discovery_ux | plain-language public-page guidance plus Greenhouse/Lever examples |
| P1-28 keep discovery controls visible | verified by Computer replay | discovery_ux | Search jobs remains visible above the scrolling preferences pane |
| P1-29 separate browser and search empty states | verified by Computer replay | discovery_ux | prior results remain visible with an explicit browser-starting message, then transition to ready |
| P0-30 preserve fast exact discovery | verified by final Computer replay | root | baseline was ~1.3 seconds; latest real rerun completed and saved in ~2.1 seconds with the exact Circle listing |
| P1-31 consistent match evidence | verified by Computer replay | root | real Circle result now shows UNKNOWN, `Remote`, and an explicit eligibility explanation; saved jobs re-score even when the ledger skips rediscovery; 100 core tests pass |
| P2-32 hide provider internals | implemented, awaiting CU replay | discovery_ux | provider and collection internals moved behind a closed Source diagnostics disclosure |
| P0-33 persist and apply original-CV mode | verified by Computer replay | original_cv_flow | Settings reports saved original default; current shortlist immediately shows Original CV unchanged and attaches the imported artifact |
| P1-34 make Settings save state obvious | verified by Computer replay | original_cv_flow | saved-default label and nearby disabled Save CV preference clearly communicate persistence |
| P1-35 explain per-job CV mode | verified by Computer replay | original_cv_flow | shortlist card names Ebrar.pdf, import time, exact-file behavior, and read-only preview |
| P1-36 warn about sensitive original-CV fields | verified by Computer replay | root | original-file review prominently warns about home address, DOB, nationality, phone, and other sensitive details |
| P0-37 allow approved upload while blocking final submit | verified by Computer replay | safe_apply_prep | real Greenhouse form attached the original PDF and stopped with Submit application visible and untouched |
| P1-38 reuse confirmed profile links | verified by Computer replay | safe_apply_prep | real Greenhouse LinkedIn Profile field contains the confirmed URL |
| P1-39 normalize provider phone values | implemented, awaiting CU replay | safe_apply_prep | selected calling code is removed from the phone text field when the ATS exposes a separate country/calling-code control; covered by focused runtime test |
| P1-40 actionable apply recovery | implemented, awaiting CU replay | application_polish | current and retained overview, attempt, timeline, run-history, and queue-recovery copy is customer-readable and strips POST/xhr/guard mechanics |
| P2-41 defer interview CTA until application completion | implemented, awaiting CU replay | application_polish | pre-submit Applications and Shortlisted surfaces hide Prepare interview; focused renderer coverage passes |
| P0-42 final-submit safety invariant | verified by Computer replay | root | real Submit application control visible and untouched after PDF upload and autofill |
| P1-43 accurate original-CV consent history | implemented, awaiting CU replay | application_polish | consent label and detail now derive from the selected artifact source; focused runtime test covers original-CV language |
| P2-44 preserve imported filename at ATS | implemented, awaiting CU replay | application_polish | runtime uploads the retained bytes with the imported customer-facing filename; focused test proves `Ebrar.pdf` reaches the form control |
| P1-45 keep Apply Copilot action visible | implemented, awaiting CU replay | application_polish | primary action and live status moved into a non-scrolling panel footer; secondary actions remain in the evidence content |
| P0-46 ignore passive CAPTCHA badges | verified by real Computer replay | root | passive reCAPTCHA no longer blocks preparation; the real form opened and was filled |
| P0-47 verify visible persisted application fields | open release blocker | root | the safety check correctly refuses a false-ready handoff, but the latest real Greenhouse run still reports Phone as unpersisted even though the live input visibly contains `44555010`; longer settling, bidirectional calling-code canonicalization, label-loss handling, and phone blur are covered by 21 passing runtime regressions but did not close the real-provider discrepancy |
| P1-48 advance listing-level Apply safely | verified by real Computer replay | root | listing-level Apply opened the real application form; final Submit application remained visible and untouched |

## Production-readiness verdict

**Not production-ready yet.** The central discovery and unchanged-original-CV flows are materially improved and the tested real source is fast and accurate. Final-submit safety held on every replay. However, a paying customer can still receive a false manual-review stop on Greenhouse's international phone widget after the visible form is correctly populated. The final fresh-profile resume import also could not be completed through the native file picker under Computer Use, so extraction has strong automated and prior real-file evidence but not a clean final fresh-user acceptance replay.

The next release gate is narrow and concrete: capture the provider's exact phone-control snapshots before and after its React rerender, make persistence evaluation agree with the visible committed country/phone pair without weakening mismatch safety, and then repeat the fresh import-to-submit-boundary run. Until both pass, the honest product position is beta/preview rather than a finished paid release.
