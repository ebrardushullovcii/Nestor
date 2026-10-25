import type { AgentDebugFindings, SourceDebugPhase } from "@nestor/contracts";

import type { AgentDebugFindingsInput } from "./workspace-service.test-runtimes";
import type { SourceDebugPhaseMap } from "./workspace-service.test-fixtures";

const sourceDebugPhaseOrder: SourceDebugPhase[] = [
  "access_auth_probe",
  "site_structure_mapping",
  "search_filter_probe",
  "job_detail_validation",
  "apply_path_validation",
  "replay_verification",
];

function withEmptyVisualFindings(
  findingsByPhase: SourceDebugPhaseMap<AgentDebugFindingsInput | null>,
): SourceDebugPhaseMap<AgentDebugFindings | null> {
  return Object.fromEntries(
    sourceDebugPhaseOrder.flatMap((phase) => {
      const findings = findingsByPhase[phase];
      return findings
        ? [
            [
              phase,
              {
                visualFindings: [],
                visualObservationSets: [],
                ...findings,
              },
            ],
          ]
        : [];
    }),
  ) as SourceDebugPhaseMap<AgentDebugFindings | null>;
}

export function createStrongSourceDebugFindingsByPhase(): SourceDebugPhaseMap<AgentDebugFindings | null> {
  return withEmptyVisualFindings({
    access_auth_probe: {
      summary:
        "Public job browsing is available without login or consent blockers.",
      reliableControls: [
        "The homepage and jobs navigation are accessible without authentication.",
      ],
      trickyFilters: [],
      navigationTips: [
        "Confirm public access first, then move to the dedicated jobs/listings route for repeatable discovery.",
      ],
      applyTips: [],
      warnings: [],
    },
    site_structure_mapping: {
      summary:
        "Use the dedicated jobs/listings route or reusable recommendation lists instead of staying on the homepage.",
      reliableControls: [
        "The jobs navigation link opens a dedicated listings page.",
        "Recommendation rows expose show-all links that open reusable prefiltered job lists.",
      ],
      trickyFilters: [],
      navigationTips: [
        "Start future discovery from the dedicated jobs/listings route rather than the homepage.",
        "If a recommendation row looks relevant, its show-all route is a valid entry path for a prefiltered result set.",
      ],
      applyTips: [],
      warnings: [],
    },
    search_filter_probe: {
      summary:
        "Keyword search plus the visible location and industry filters change the result set reliably.",
      reliableControls: [
        "Use the keyword search box on the listings route to refresh the visible job set.",
        "Use the visible location filter to narrow the listings by city or region.",
        "Use the visible industry filter to narrow the listings by sector.",
        "Recommendation show-all routes can open large reusable result sets with site-preselected filters already applied.",
      ],
      trickyFilters: [
        "Homepage promo chips that do not open a full result list should be ignored.",
      ],
      navigationTips: [],
      applyTips: [],
      warnings: [],
    },
    job_detail_validation: {
      summary:
        "Open the same-host detail page from the listing card to recover canonical job data.",
      reliableControls: [],
      trickyFilters: [],
      navigationTips: [
        "Open the listing card detail page instead of relying on inline card previews.",
      ],
      applyTips: [],
      warnings: [],
    },
    apply_path_validation: {
      summary:
        "Sampled job details did not expose a reliable on-site apply entry.",
      reliableControls: [],
      trickyFilters: [],
      navigationTips: [],
      applyTips: [
        "Treat applications as manual unless a detail page clearly exposes a stable apply entry.",
      ],
      warnings: [],
    },
    replay_verification: {
      summary:
        "Replay from the listings route reproduced the searchable and filterable job flow.",
      reliableControls: [
        "The listings route, keyword search, and visible filters remained stable on replay.",
      ],
      trickyFilters: [],
      navigationTips: [
        "Reuse the listings route, recommendation show-all paths, and keyword search path during normal discovery.",
      ],
      applyTips: [],
      warnings: [],
    },
  });
}
