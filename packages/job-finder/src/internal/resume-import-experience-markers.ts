import {
  ResumeImportFieldCandidateSchema,
  type ResumeDocumentBundle,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import { buildValuePreview } from "@nestor/ai-providers";

import { isObject } from "./resume-import-common";
import { uniqueStrings } from "./shared";

function isCompanyMarkerText(text: string): boolean {
  return /^[A-Z0-9&.'()/-]+(?:\s+[A-Z0-9&.'()/-]+)*\s*[–—-]\s*[A-Z][A-Z\s.'-]+,\s*[A-Z][A-Z\s.'-]+$/.test(
    text.trim(),
  );
}

function parseCompanyMarkerText(text: string): {
  companyName: string | null;
  location: string | null;
} {
  const match = text
    .trim()
    .match(
      /^([A-Z0-9&.'()/-]+(?:\s+[A-Z0-9&.'()/-]+)*)\s*[–—-]\s*([A-Z][A-Z\s.'-]+,\s*[A-Z][A-Z\s.'-]+)$/,
    );

  if (!match) {
    return { companyName: null, location: null };
  }

  return {
    companyName: match[1]?.trim() || null,
    location:
      match[2]
        ?.toLowerCase()
        .replace(/\b[a-z]/g, (character) => character.toUpperCase())
        .trim() || null,
  };
}

function looksLikeContinuationPrefix(lines: readonly string[]): boolean {
  if (lines.length === 0) {
    return false;
  }

  let sawBullet = false;

  for (const line of lines) {
    if (/^[•●▪◦‣■]/.test(line)) {
      sawBullet = true;
      continue;
    }

    if (isCompanyMarkerText(line)) {
      return false;
    }

    if (/\b\d{1,2}\/\d{4}\b/.test(line)) {
      return false;
    }

    if (/^[A-Z][A-Z\s&.'()/-]{8,}$/.test(line)) {
      return false;
    }
  }

  return sawBullet;
}

function inferCompanyMarkerFromPreviousPageContinuation(
  bundle: ResumeDocumentBundle,
  sourceBlock: ResumeDocumentBundle["blocks"][number],
  evidenceText: string | null,
): { companyName: string | null; location: string | null } | null {
  if (sourceBlock.pageNumber <= 1 || !evidenceText) {
    return null;
  }

  const currentPage = bundle.pages.find(
    (page) => page.pageNumber === sourceBlock.pageNumber,
  );
  const previousPage = bundle.pages.find(
    (page) => page.pageNumber === sourceBlock.pageNumber - 1,
  );

  if (!currentPage?.text || !previousPage?.text) {
    return null;
  }

  const currentLines = currentPage.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = currentLines.findIndex(
    (line) => line === evidenceText || line.includes(evidenceText),
  );

  if (headerIndex <= 0) {
    return null;
  }

  const leadingLines = currentLines.slice(0, headerIndex);
  if (!looksLikeContinuationPrefix(leadingLines)) {
    return null;
  }

  const previousLines = previousPage.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = previousLines.length - 1; index >= 0; index -= 1) {
    const line = previousLines[index];

    if (!line || !isCompanyMarkerText(line)) {
      continue;
    }

    const marker = parseCompanyMarkerText(line);
    if (marker.companyName || marker.location) {
      return marker;
    }
  }

  return null;
}

function inferCompanyMarkerFromPageFlow(
  bundle: ResumeDocumentBundle,
  evidenceText: string | null,
): { companyName: string | null; location: string | null } | null {
  if (!evidenceText) {
    return null;
  }

  const pages = [...bundle.pages].sort(
    (left, right) => left.pageNumber - right.pageNumber,
  );

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];

    if (!page?.text || !page.text.includes(evidenceText)) {
      continue;
    }

    const lines = page.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const headerIndex = lines.findIndex(
      (line) => line === evidenceText || line.includes(evidenceText),
    );

    if (headerIndex === -1) {
      continue;
    }

    for (let index = headerIndex - 1; index >= 0; index -= 1) {
      const line = lines[index];

      if (!line) {
        continue;
      }

      if (isCompanyMarkerText(line)) {
        const marker = parseCompanyMarkerText(line);
        if (marker.companyName || marker.location) {
          return marker;
        }
      }
    }

    const leadingLines = lines.slice(0, headerIndex);
    if (!looksLikeContinuationPrefix(leadingLines)) {
      return null;
    }

    for (
      let previousPageIndex = pageIndex - 1;
      previousPageIndex >= 0;
      previousPageIndex -= 1
    ) {
      const previousPage = pages[previousPageIndex];

      if (!previousPage?.text) {
        continue;
      }

      const previousLines = previousPage.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (
        let previousLineIndex = previousLines.length - 1;
        previousLineIndex >= 0;
        previousLineIndex -= 1
      ) {
        const line = previousLines[previousLineIndex];

        if (!line || !isCompanyMarkerText(line)) {
          continue;
        }

        const marker = parseCompanyMarkerText(line);
        if (marker.companyName || marker.location) {
          return marker;
        }
      }
    }

    return null;
  }

  return null;
}

export function enrichExperienceCandidatesFromNearbyMarkers(
  bundle: ResumeDocumentBundle,
  candidates: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidate[] {
  return candidates.map((candidate) => {
    if (candidate.target.section !== "experience") {
      return candidate;
    }

    if (!isObject(candidate.value)) {
      return candidate;
    }

    const experienceValue = candidate.value;
    if (experienceValue.companyName || experienceValue.location) {
      return candidate;
    }

    const sourceBlockId = candidate.sourceBlockIds[0];
    if (sourceBlockId) {
      const sourceIndex = bundle.blocks.findIndex(
        (block) => block.id === sourceBlockId,
      );

      if (sourceIndex !== -1) {
        const sourceBlock = bundle.blocks[sourceIndex];

        if (sourceBlock) {
          for (
            let index = sourceIndex - 1;
            index >= 0 && index >= sourceIndex - 12;
            index -= 1
          ) {
            const block = bundle.blocks[index];

            if (!block || block.pageNumber !== sourceBlock.pageNumber) {
              continue;
            }

            if (!isCompanyMarkerText(block.text)) {
              continue;
            }

            const marker = parseCompanyMarkerText(block.text);
            if (!marker.companyName && !marker.location) {
              break;
            }

            const nextValue = {
              ...experienceValue,
              companyName:
                typeof experienceValue.companyName === "string" &&
                experienceValue.companyName.trim()
                  ? experienceValue.companyName
                  : marker.companyName,
              location:
                typeof experienceValue.location === "string" &&
                experienceValue.location.trim()
                  ? experienceValue.location
                  : marker.location,
            };

            return ResumeImportFieldCandidateSchema.parse({
              ...candidate,
              label:
                typeof experienceValue.title === "string" &&
                experienceValue.title &&
                marker.companyName
                  ? `${experienceValue.title} at ${marker.companyName}`
                  : candidate.label,
              value: nextValue,
              valuePreview: buildValuePreview(nextValue),
              sourceBlockIds: uniqueStrings([
                block.id,
                ...candidate.sourceBlockIds,
              ]),
              confidence: Math.min(0.78, candidate.confidence + 0.12),
            });
          }

          const previousPageMarker =
            inferCompanyMarkerFromPreviousPageContinuation(
              bundle,
              sourceBlock,
              candidate.evidenceText,
            );

          if (previousPageMarker?.companyName || previousPageMarker?.location) {
            const nextValue = {
              ...experienceValue,
              companyName:
                typeof experienceValue.companyName === "string" &&
                experienceValue.companyName.trim()
                  ? experienceValue.companyName
                  : previousPageMarker.companyName,
              location:
                typeof experienceValue.location === "string" &&
                experienceValue.location.trim()
                  ? experienceValue.location
                  : previousPageMarker.location,
            };

            return ResumeImportFieldCandidateSchema.parse({
              ...candidate,
              label:
                typeof experienceValue.title === "string" &&
                experienceValue.title &&
                previousPageMarker.companyName
                  ? `${experienceValue.title} at ${previousPageMarker.companyName}`
                  : candidate.label,
              value: nextValue,
              valuePreview: buildValuePreview(nextValue),
              confidence: Math.min(0.74, candidate.confidence + 0.1),
            });
          }
        }
      }
    }

    const pageFlowMarker = inferCompanyMarkerFromPageFlow(
      bundle,
      candidate.evidenceText,
    );

    if (pageFlowMarker?.companyName || pageFlowMarker?.location) {
      const nextValue = {
        ...experienceValue,
        companyName:
          typeof experienceValue.companyName === "string" &&
          experienceValue.companyName.trim()
            ? experienceValue.companyName
            : pageFlowMarker.companyName,
        location:
          typeof experienceValue.location === "string" &&
          experienceValue.location.trim()
            ? experienceValue.location
            : pageFlowMarker.location,
      };

      return ResumeImportFieldCandidateSchema.parse({
        ...candidate,
        label:
          typeof experienceValue.title === "string" &&
          experienceValue.title &&
          pageFlowMarker.companyName
            ? `${experienceValue.title} at ${pageFlowMarker.companyName}`
            : candidate.label,
        value: nextValue,
        valuePreview: buildValuePreview(nextValue),
        confidence: Math.min(0.74, candidate.confidence + 0.1),
      });
    }

    return candidate;
  });
}
