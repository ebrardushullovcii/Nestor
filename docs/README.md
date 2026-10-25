# Documentation

Read only what the task needs. Code shows current behavior; ADRs record deliberate decisions. Investigate a mismatch before treating either the implementation or the decision as wrong.

| Need                                         | Read                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| why something is the way it is               | `docs/adr/README.md`, then the ADR                                                  |
| product scope and module behavior            | `docs/PRODUCT.md`, `docs/modules/JOB_FINDER.md`, `docs/modules/LIVE_ASSISTANT.md` |
| durable product direction                    | `docs/GOALS.md`                                                                     |
| package ownership, data flow, boundary rules | `docs/ARCHITECTURE.md`                                                              |
| cross-package contract invariants            | `docs/CONTRACTS.md` (field detail lives in `packages/contracts`)                    |
| which check to run, stop rules, safety rules | `docs/TESTING.md`                                                                   |
| AI model and provider setup                  | `docs/AI_PROVIDER_SETUP.md`                                                         |
| domain vocabulary                            | `CONTEXT.md`                                                                        |
| UI design references                         | `docs/Design/README.md`                                                             |

Historical audit reports and evidence manifests live in `docs/audits/`. They are records of past runs that the release-evidence scripts fingerprint, not guidance; do not read them for current state.
