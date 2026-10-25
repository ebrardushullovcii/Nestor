# AI Model Capability Benchmark Pilot

Date: 2026-08-12

Corpus digest: `14f063e6b46876c1a356699fd78162c3d849ed16d505223a7b1524d39e9f4380`

> Historical pilot. The subsequently authorized 330-outcome matrix is complete. Use
> `docs/audits/AI_MODEL_CAPABILITY_BENCHMARK_FULL_2026-08-12.html` for current
> model routing, latency, reliability, and follow-up decisions.

## Scope

The pilot ran the first two synthetic cases in each of eleven current model-backed capabilities through:

- `gpt-5.6-luna` with high reasoning;
- `gpt-5.6-luna` with max reasoning;
- `gpt-5.6-sol` with low reasoning;
- a separate Codex Sol-medium agent reference using the same disclosed synthetic evidence.

The 66 system outcomes made 129 provider calls. All runs used the Responses API with `store: false`. Raw request/response bodies were captured without authorization headers. The real workspace, personal résumé fixtures, live job sources, credentials, accounts, applications, and final submission were excluded.

The Codex reference completed 22 cases, but its per-case elapsed time was not available inside the batched agent turn. Its `durationMs: 0` values are explicit unavailable sentinels and are excluded from latency comparisons.

## Overall pilot result

| Lane | Direct workflow success | Fallbacks | Guarded rejections | Median case time | Mean case time |
|---|---:|---:|---:|---:|---:|
| Luna high | 16 / 22 | 6 | 10 | 14.1s | 16.1s |
| Luna max | 16 / 22 | 6 | 10 | 31.7s | 39.1s |
| Sol low | 16 / 22 | 6 | 10 | 11.4s | 17.1s |
| Codex agent reference | 22 / 22 | 0 | 0 | not measured | not measured |

The preliminary evidence-coverage scores were Luna high 63.1, Luna max 64.3, Sol low 63.6, and Codex reference 87.8 for raw contribution. These are triage metrics, not final rankings. They combine field/token coverage with schema, fallback, and rejection penalties and must not replace manual output review.

## Manual review

| Capability | Current finding | Pilot recommendation |
|---|---|---|
| Résumé text import | Luna high missed the Northstar experience in the clean case and incorrectly treated a sparse résumé headline as experience. Luna max and Sol low preserved the clean chronology; Luna max took 121–157s versus Sol low's 32–43s. | Sol low is the strongest system default from this pilot. Luna max did not justify its latency. |
| Résumé vision | All lanes read the visible facts, but all emitted candidate shapes rejected by the product schema, leaving zero usable candidates. | No model winner. Fix the prompt/schema integration before judging end-user quality. Sol low was fastest raw. |
| Résumé generation | All lanes proposed a reasonable grounded summary, but only the summary fragment was returned and the product used deterministic fallback. | No usable winner. This is an integration defect, not evidence that max reasoning is better. |
| Guided Edits | All lanes proposed understandable edits with unsupported patch shapes; product guards dropped every patch. | No usable winner. Sol low exposed the same defect fastest. |
| Profile Copilot | All lanes understood the headline request but used unsupported proposal operations and `applyMode` values; deterministic fallback produced the user-visible edit. | No usable direct winner. Sol low had the lowest latency. |
| Job-page extraction | After one preserved transient `server_is_overloaded` retry, all lanes extracted both sparse cards and the rich job accurately. Every lane missed the relative apply URL. | Luna high was slightly fastest; quality was otherwise tied. Add explicit relative-apply-URL scoring. |
| Agentic job discovery | All lanes found the expected distinct synthetic jobs without unsafe action. Luna high had the best median time and useful summaries. | Luna high is the pilot winner for browser discovery. |
| Source debug | Sol low accurately said result-changing search and detail navigation were unverified. Luna high and max claimed a query route changed even though captured phase evidence showed only the original `/jobs` route and a filled textbox. | Sol low is the pilot accuracy winner. Do not prefer more confident wording over captured evidence. |
| Browser visual analysis | All raw outputs correctly noticed the overlay/cards, but every lane failed the safe observation schema and invoked deterministic fallback. | No usable direct winner. Sol low was fastest raw; integration must be fixed. |
| Interview cue | All lanes were grounded and useful. Luna max gave the strongest STAR-shaped coaching but was much slower; Luna high was concise and fastest. | Luna high is the best interactive tradeoff; max may be reserved for explicitly deep coaching. |
| Interview screenshot vision | All lanes correctly explained the compiler error and architecture diagram. | Sol low is the pilot winner on equal quality and lowest latency. |

## Product defects exposed by raw-output capture

- Profile Copilot model output uses unsupported generic patch operations and `applyMode: "auto"`; product fallbacks previously hid this.
- Résumé generation returns a partial summary object instead of a complete `TailoredResumeDraft` contribution.
- Guided Edits returns generic patch formats rather than the required typed résumé patch contract.
- Résumé vision uses shorthand candidate targets and inconsistent visual-evidence fields; the product rejects all candidates.
- Browser visual output contains useful observations but fails the safe observation schema, so the product appends deterministic fallback observations.
- Job extraction does not resolve an explicitly visible relative apply URL.
- Source-debug final guidance can overstate a successful result change that is absent from the captured interaction evidence.

## Why the pilot initially gated the full 10-case matrix

The pilot intentionally gates full scale. Four case families currently relabel nearly identical fixtures instead of exercising the promised behavior:

- browser discovery does not yet implement real pagination, infinite scroll, multilingual cards, guest banners, or route-drift duplicates;
- source-debug does not yet implement working versus fake filters, cookie dismissal, broken/download routes, or mandatory-login redirects, and the separate production final instruction-review call is not yet invoked;
- résumé-vision cases use the same generic document layout except for resolution;
- browser/interview screenshot cases render descriptive text on a generic page instead of the actual UI, chart, code, diagram, modal, loading, and error layouts named by the cases.

Running 110 cases × 3 system lanes now would create precise-looking but misleading numbers. Full scale is gated on distinct behavior-backed fixtures, source-instruction review coverage, and a second audit of objective graders.

## Artifacts and reproduction

Generated raw artifacts remain ignored under `.tmp/ai-evals/pilot_v1_14f063e6b468/`. The machine-readable report is `pilot-report.json`; the generated table report is `pilot-report.md`. The preserved Sol-low overload response is `job_page_extraction_sparse_cards.overload-attempt.json` beside the successful retry.

Commands:

```powershell
pnpm ai:benchmark plan
pnpm ai:benchmark pilot luna_high
pnpm ai:benchmark pilot luna_max
pnpm ai:benchmark pilot sol_low
pnpm ai:benchmark report
```

The pilot runner is resumable and skips validated per-case artifacts on subsequent runs.

## Historical nearest-checkpoint comparison

At this stage, benchmarking stopped at the then-requested nearest reliable checkpoint instead of expanding immediately to the planned 110-case matrix. The comparison used one identical representative synthetic case from each of the eleven capabilities for each system lane: 33 comparable outcomes in total. The user later authorized the complete matrix; the current result is in `docs/audits/AI_MODEL_CAPABILITY_BENCHMARK_FULL_2026-08-12.html`.

| Capability | Luna high | Luna max | Sol low | Recommendation |
|---|---:|---:|---:|---|
| Résumé text import | 41.5s; direct | 121.1s; direct | 43.0s; direct | **Sol low.** Comparable clean chronology at about one-third of max latency. Luna high had accuracy regressions elsewhere in the pilot. |
| Résumé vision | 26.6s; all candidates rejected | 36.2s; all candidates rejected | 11.6s; all candidates rejected | **No production winner.** Fix the candidate-schema integration first; use Sol low only for development because it exposes the same failure fastest. |
| Résumé generation | 11.8s; fallback | 34.1s; fallback | 7.8s; fallback | **No production winner.** Every model returned a partial contribution and deterministic generation won. |
| Guided Edits | 18.1s; proposal rejected | 30.7s; proposal rejected | 8.0s; proposal rejected | **No production winner.** Fix typed patch output; Sol low is the fastest diagnostic lane. |
| Profile Copilot | 12.9s; fallback | 19.5s; fallback | 11.2s; fallback | **No direct-model winner.** Product fallback produced the visible edit; Sol low is the least costly current configuration. |
| Job-page extraction | 8.5s; direct | 13.8s; direct | 9.4s; direct | **Luna high**, narrowly, on equal reviewed quality. All three missed the visible relative apply URL. |
| Agentic job discovery | 24.7s; direct | 44.9s; direct | 43.1s; direct | **Luna high.** It reached the same useful-job target substantially faster. |
| Source debug | 22.0s; direct | 37.0s; direct | 36.7s; direct | **Sol low for accuracy.** It was more honest about unverified behavior; Luna high/max overclaimed a result-changing route. |
| Browser visual analysis | 10.0s; raw schema rejected | 55.7s; raw schema rejected | 9.7s; raw schema rejected | **No production winner.** Fix the safe observation schema; Sol low is the fastest development lane. |
| Interview cue | 7.2s; direct | 28.5s; direct | 10.9s; direct | **Luna high.** Best latency-quality tradeoff for interactive use; max's extra structure did not justify 4x latency. |
| Interview screenshot vision | 7.3s; direct | 4.9s; direct | 4.5s; direct | **Sol low.** Equal reviewed correctness and lowest latency. |

Failure interpretation:

- Five capabilities are not valid model contests yet: résumé vision, résumé generation, Guided Edits, Profile Copilot, and browser visual analysis. In each, the app rejected or replaced the model contribution. A polished fallback is product resilience, not model quality.
- One preserved Sol-low transport overload occurred on a different job-extraction case and succeeded on targeted retry. It remains a reliability observation, not a quality zero.
- A harder six-case Sol canary supported the same integration diagnosis: résumé text import and résumé generation fell back; vision, Guided Edits, Profile Copilot, and detail-pane extraction returned within 1.4–12.5 seconds. The canary timed out at the outer command boundary before the five browser/interview cases ran, so it is not used for cross-model scoring.

### Recommended current routing

- Use **Luna high** for job-page extraction, browser-agent discovery, and Interview Helper cue generation.
- Use **Sol low** for résumé text import, source-debug review, and Interview Helper screenshot vision.
- Keep deterministic guarded behavior for résumé generation, Guided Edits, Profile Copilot, résumé vision, and browser visual analysis until their typed provider contracts are fixed; selecting Luna max does not repair those integration failures.
- Do not use Luna max as a default from this evidence. It was usually two to five times slower and produced no capability win that changes the current routing decision.

### Preserved follow-up work

- Complete capability-specific graders for résumé chronology/entity precision, guided/profile patch semantics, visual fact precision/recall, and source action/evidence invariants.
- Add structured synthetic state for long résumé histories, project-heavy candidates, ambiguous Copilot requests, noisy/repeated Interview cues, and visual-observation cue context.
- Add runner/prompt/fixture hashes to manifests so code changes cannot reuse stale artifacts under the same corpus digest.
- The later full runner added exact 330-outcome completeness, lane-specific manifests, stale-artifact rejection, and resumable validated checkpoints. Current remaining work is listed in the full HTML report.
