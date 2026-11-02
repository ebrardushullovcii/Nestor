/**
 * A listing's description as paragraphs, ready to read under the details
 * header: runs of blank lines fold into one paragraph break, lines inside a
 * paragraph keep their breaks, and lines in the opening paragraphs that only
 * repeat the title, the employer or the place (already in the header) are
 * dropped, with a short banner line that leads into them.
 */
export function cleanDescription(
  description: string,
  header: { title: string; company: string; location: string },
): string[] {
  const paragraphs = description
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean);
  const known = [header.title, header.company, header.location]
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 1)
    .sort((a, b) => b.length - a.length);
  const repeatsHeader = (paragraph: string) => {
    if (paragraph.length > 200) return false;
    let rest = paragraph.toLowerCase();
    for (const part of known) rest = rest.split(part).join(" ");
    // Facts the header's fact line already gives: when it was posted
    // ("Posted 6d ago", "posted 3 days ago") and how it is worked.
    rest = rest
      .replace(/\b(posted|updated|listed)\b[^·•|\n]*/g, " ")
      .replace(
        /\b(remote|hybrid|on-?site|in office|full[- ]time|part[- ]time|contract|permanent|temporary)\b/g,
        " ",
      );
    // What is left is only joining words and punctuation: "at", "in", "·".
    return (
      rest
        .replace(/\b(at|in|for|with|the|job|role|company|location)\b/g, " ")
        .replace(/[\s·•|,.:;()\-–—/]+/g, "") === ""
    );
  };
  // The opening (first three paragraphs) loses every line that only
  // repeats the header, wherever it sits in them, and a short call-out
  // ("We're hiring!") that leads straight into such a line.
  const opening = Math.min(paragraphs.length, 3);
  const firstLines = paragraphs.slice(0, opening).join("\n").split("\n");
  const banner =
    firstLines.length > 1 &&
    (firstLines[0] ?? "").length <= 40 &&
    // A call-out, not a heading: "We're hiring!", "JOIN OUR TEAM".
    (/!$/.test(firstLines[0] ?? "") || !/\p{Ll}/u.test(firstLines[0] ?? "")) &&
    !repeatsHeader(firstLines[0] ?? "") &&
    repeatsHeader(firstLines[1] ?? "");
  const cleaned = paragraphs.map((paragraph, index) => {
    if (index >= opening) return paragraph;
    return paragraph
      .split("\n")
      .filter(
        (line, at) =>
          !repeatsHeader(line) && !(banner && index === 0 && at === 0),
      )
      .join("\n");
  });
  const kept = cleaned.filter(Boolean);
  // Never empty a description that said something.
  return kept.length > 0 ? kept : paragraphs;
}
