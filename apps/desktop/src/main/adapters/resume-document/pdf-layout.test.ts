import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { inspectPdfLayout } from "./pdf";

// A synthetic two-page PDF: page one is full; page two has one line at y.
function pdf(y: number) {
  const stream = (text: string) =>
    `<< /Length ${text.length} >>\nstream\n${text}endstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 12 Tf 45 55 Td (Full first page) Tj ET\n"),
    stream(`BT /F1 12 Tf 45 ${y} Td (Last page content) Tj ET\n`),
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 8\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return text;
}

test("measures the printed last page rather than the first or a word estimate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "resume-layout-"));
  try {
    const file = path.join(dir, "synthetic.pdf");
    await writeFile(file, pdf(660));
    const sparse = await inspectPdfLayout(file);
    expect(sparse.pageCount).toBe(2);
    expect(sparse.lastPageFillRatio).toBeLessThan(0.2);
    await writeFile(file, pdf(300));
    expect((await inspectPdfLayout(file)).lastPageFillRatio).toBeGreaterThan(
      0.6,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
