import { Fragment, type ReactNode } from "react";

type MarkdownBlock =
  | { type: "paragraph"; content: string }
  | { type: "heading"; content: string; level: number }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "blockquote"; content: string }
  | { type: "code"; content: string; language: string | null }
  | { type: "divider" };

const blockStarterPatterns = [
  /^\s*```/,
  /^\s{0,3}(#{1,4})\s+/,
  /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
  /^\s*[-*+]\s+/,
  /^\s*\d+\.\s+/,
  /^\s*>\s?/,
];

const inlinePatternDefinitions = [
  {
    regex: /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    render: (match: RegExpMatchArray, key: string) => (
      <span key={key} className="inline-flex flex-wrap items-baseline gap-1">
        <span className="font-medium text-foreground">{match[1]}</span>
        <span className="text-muted-foreground">({match[2]})</span>
      </span>
    ),
  },
  {
    regex: /^`([^`\n]+)`/,
    render: (match: RegExpMatchArray, key: string) => (
      <code
        key={key}
        className="rounded-(--radius-small) border border-border/35 bg-background/80 px-1.5 py-0.5 font-mono text-(length:--text-small) break-all text-foreground"
      >
        {match[1]}
      </code>
    ),
  },
  {
    regex: /^\*\*([^\n]+?)\*\*/,
    render: (match: RegExpMatchArray, key: string) => (
      <strong key={key} className="font-semibold text-foreground">
        {renderInlineContent(match[1] ?? "", `${key}_strong`)}
      </strong>
    ),
  },
  {
    regex: /^__([^\n]+?)__/,
    render: (match: RegExpMatchArray, key: string) => (
      <strong key={key} className="font-semibold text-foreground">
        {renderInlineContent(match[1] ?? "", `${key}_strong`)}
      </strong>
    ),
  },
] as const;

function isBlockStarter(line: string): boolean {
  return blockStarterPatterns.some((pattern) => pattern.test(line));
}

function findNextInlineTokenIndex(value: string): number {
  const markers = ["[", "`", "**", "__"];
  let closestIndex = -1;

  for (const marker of markers) {
    const index = value.indexOf(marker);
    if (index !== -1 && (closestIndex === -1 || index < closestIndex)) {
      closestIndex = index;
    }
  }

  return closestIndex;
}

function pushTextNodes(nodes: ReactNode[], value: string, key: string) {
  const lines = value.split("\n");

  lines.forEach((line, index) => {
    if (line.length > 0) {
      nodes.push(<Fragment key={`${key}_${index}`}>{line}</Fragment>);
    }

    if (index < lines.length - 1) {
      nodes.push(<br key={`${key}_break_${index}`} />);
    }
  });
}

function renderInlineContent(content: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = content;
  let nodeIndex = 0;

  while (remaining.length > 0) {
    const matchDefinition = inlinePatternDefinitions.find(({ regex }) =>
      regex.test(remaining),
    );
    if (matchDefinition) {
      const match = remaining.match(matchDefinition.regex);

      if (match) {
        nodes.push(matchDefinition.render(match, `${keyPrefix}_${nodeIndex}`));
        remaining = remaining.slice(match[0].length);
        nodeIndex += 1;
        continue;
      }
    }

    const nextInlineTokenIndex = findNextInlineTokenIndex(remaining);
    if (nextInlineTokenIndex === 0) {
      pushTextNodes(
        nodes,
        remaining[0] ?? "",
        `${keyPrefix}_literal_${nodeIndex}`,
      );
      remaining = remaining.slice(1);
      nodeIndex += 1;
      continue;
    }

    const textSegment =
      nextInlineTokenIndex === -1
        ? remaining
        : remaining.slice(0, nextInlineTokenIndex);
    pushTextNodes(nodes, textSegment, `${keyPrefix}_text_${nodeIndex}`);
    remaining = remaining.slice(textSegment.length);
    nodeIndex += 1;
  }

  return nodes;
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const codeFenceMatch = line.match(/^\s*```([\w-]+)?\s*$/);
    if (codeFenceMatch) {
      index += 1;
      const codeLines: string[] = [];

      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({
        type: "code",
        content: codeLines.join("\n"),
        language: codeFenceMatch[1] ?? null,
      });
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        content: headingMatch[2] ?? "",
        level: headingMatch[1]?.length ?? 1,
      });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }

    const unorderedListMatch = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (unorderedListMatch) {
      const items: string[] = [unorderedListMatch[1] ?? ""];
      index += 1;

      while (index < lines.length) {
        const nextLineMatch = (lines[index] ?? "").match(
          /^\s*[-*+]\s+(.+?)\s*$/,
        );
        if (!nextLineMatch) {
          break;
        }

        items.push(nextLineMatch[1] ?? "");
        index += 1;
      }

      blocks.push({ type: "unordered-list", items });
      continue;
    }

    const orderedListMatch = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (orderedListMatch) {
      const items: string[] = [orderedListMatch[1] ?? ""];
      index += 1;

      while (index < lines.length) {
        const nextLineMatch = (lines[index] ?? "").match(
          /^\s*\d+\.\s+(.+?)\s*$/,
        );
        if (!nextLineMatch) {
          break;
        }

        items.push(nextLineMatch[1] ?? "");
        index += 1;
      }

      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const blockquoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (blockquoteMatch) {
      const quoteLines: string[] = [blockquoteMatch[1] ?? ""];
      index += 1;

      while (index < lines.length) {
        const nextLineMatch = (lines[index] ?? "").match(/^\s*>\s?(.*)$/);
        if (!nextLineMatch) {
          break;
        }

        quoteLines.push(nextLineMatch[1] ?? "");
        index += 1;
      }

      blocks.push({ type: "blockquote", content: quoteLines.join("\n") });
      continue;
    }

    const paragraphLines = [line.trimEnd()];
    index += 1;

    while (index < lines.length) {
      const nextLine = lines[index] ?? "";
      if (nextLine.trim().length === 0 || isBlockStarter(nextLine)) {
        break;
      }

      paragraphLines.push(nextLine.trimEnd());
      index += 1;
    }

    blocks.push({ type: "paragraph", content: paragraphLines.join("\n") });
  }

  return blocks.length > 0 ? blocks : [{ type: "paragraph", content }];
}

function renderMarkdownBlock(block: MarkdownBlock, key: string) {
  switch (block.type) {
    case "heading": {
      const headingClassName =
        block.level <= 2
          ? "font-display text-sm font-semibold text-foreground"
          : "text-sm font-semibold text-foreground";

      return (
        <h3 className={headingClassName} key={key}>
          {renderInlineContent(block.content, `${key}_heading`)}
        </h3>
      );
    }
    case "unordered-list":
      return (
        <ul className="grid list-disc gap-1 pl-5 text-foreground" key={key}>
          {block.items.map((item, index) => (
            <li className="pl-1" key={`${key}_item_${index}`}>
              {renderInlineContent(item, `${key}_item_${index}`)}
            </li>
          ))}
        </ul>
      );
    case "ordered-list":
      return (
        <ol className="grid list-decimal gap-1 pl-5 text-foreground" key={key}>
          {block.items.map((item, index) => (
            <li className="pl-1" key={`${key}_item_${index}`}>
              {renderInlineContent(item, `${key}_item_${index}`)}
            </li>
          ))}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote
          className="border-l-2 border-border/40 pl-3 text-foreground-soft"
          key={key}
        >
          {renderInlineContent(block.content, `${key}_blockquote`)}
        </blockquote>
      );
    case "code":
      return (
        <div className="grid gap-2" key={key}>
          {block.language ? (
            <p className="text-(length:--text-label-mono-xs) text-muted-foreground">
              {block.language}
            </p>
          ) : null}
          <pre className="overflow-x-auto rounded-(--radius-chip) border border-border/35 bg-background/80 p-3 font-mono text-(length:--text-small) leading-6 text-foreground">
            <code>{block.content}</code>
          </pre>
        </div>
      );
    case "divider":
      return <hr className="border-0 border-t border-border/35" key={key} />;
    case "paragraph":
    default:
      return (
        <p
          className="whitespace-pre-wrap break-words text-foreground"
          key={key}
        >
          {renderInlineContent(block.content, `${key}_paragraph`)}
        </p>
      );
  }
}

/**
 * Replies render as plain text with limited markdown: paragraphs, small
 * headings, lists, quotes, code and bold.
 */
export function AssistantMarkdown(props: { content: string }) {
  const blocks = parseMarkdownBlocks(props.content);

  return (
    // A long id or address must wrap inside the panel, never widen it: grid
    // items do not shrink below their longest word unless told to.
    <div
      className="grid min-w-0 gap-2 break-words [overflow-wrap:anywhere] [&>*]:min-w-0"
      data-assistant-markdown="true"
    >
      {blocks.map((block, index) =>
        renderMarkdownBlock(block, `block_${index}`),
      )}
    </div>
  );
}
