import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const JOB_FINDER_DEMO_RESUME_FORMAT = "pdf" as const;

function createMinimalPdf(title: string, body: string) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${body}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n% Nestor deterministic demo PDF\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  const xrefEntries = offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (${title}) >> >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

export const JOB_FINDER_DEMO_SOURCE_RESUME_CONTENT = createMinimalPdf(
  "Alex Vanguard source resume",
  "Alex Vanguard - Senior systems designer",
);

export const JOB_FINDER_DEMO_EXPORT_RESUME_CONTENT = createMinimalPdf(
  "Alex Vanguard tailored resume",
  "Alex Vanguard - Tailored resume",
);

const demoDirectory = path.join(os.tmpdir(), "nestor-demo-resume-files");

export const JOB_FINDER_DEMO_SOURCE_RESUME_PATH = path.join(
  demoDirectory,
  "alex-vanguard.pdf",
);

export const JOB_FINDER_DEMO_READY_RESUME_PATH = path.join(
  demoDirectory,
  "job-ready-resume.pdf",
);

export const JOB_FINDER_DEMO_CONSENT_RESUME_PATH = path.join(
  demoDirectory,
  "job-consent-queue-resume.pdf",
);

function sha256Utf8(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export const JOB_FINDER_DEMO_SOURCE_RESUME_SHA256 = sha256Utf8(
  JOB_FINDER_DEMO_SOURCE_RESUME_CONTENT,
);

export const JOB_FINDER_DEMO_EXPORT_RESUME_SHA256 = sha256Utf8(
  JOB_FINDER_DEMO_EXPORT_RESUME_CONTENT,
);
