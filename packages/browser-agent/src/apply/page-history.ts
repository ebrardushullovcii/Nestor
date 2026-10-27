import type { AgentMessage } from "../types";

/** Replace only exact host-generated page views, retaining calls and their results. */
export function compactApplyPageHistory(
  messages: readonly AgentMessage[],
  pageViews: ReadonlySet<string>,
  currentPage: string,
): AgentMessage[] {
  const views = [...pageViews].sort((a, b) => b.length - a.length);
  const compacted = messages.map((message) => {
    if (message.role !== "tool" && message.role !== "user") return message;
    let content = message.content;
    for (const view of views)
      content = content.replaceAll(
        view,
        "[Earlier page view replaced by the current page below.]",
      );
    return content === message.content ? message : { ...message, content };
  });
  const snapshot = `Current application page in full. Use only these current handles and field values:\n\n${currentPage}`;
  const last = compacted.at(-1);
  if (last?.role === "user" || last?.role === "tool")
    return [
      ...compacted.slice(0, -1),
      { ...last, content: `${last.content}\n\n${snapshot}` },
    ];
  return [...compacted, { role: "user", content: snapshot }];
}
