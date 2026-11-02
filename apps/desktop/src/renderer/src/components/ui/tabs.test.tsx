// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import tabsSource from "./tabs.tsx?raw";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function extractLine(name: string): string {
  const line = tabsSource
    .split("\n")
    .find((candidate) => candidate.includes(name));

  if (!line) {
    throw new Error(`Missing ${name} in tabs.tsx`);
  }

  return line;
}

describe("Tabs: one underline idiom for page sections", () => {
  it("draws both list variants as a hairline with no filled strip", () => {
    const line = extractLine('line: "');
    const byDefault = extractLine('default: "');
    expect(line).toBe(byDefault.replace("default:", "line:"));
    expect((line.match(/border-b/g) ?? []).length).toBe(1);
    expect(line).toContain("border-(--border-subtle)");
    expect(tabsSource).not.toContain('"bg-muted"');
  });

  it("marks the active tab with a 2px accent underline and a weight step", () => {
    const indicatorRule = extractLine("after:opacity-100");
    expect(indicatorRule).toContain("data-[state=active]:after:bg-primary");
    expect(indicatorRule).toContain("after:h-0.5");
    expect(indicatorRule).not.toContain("after:h-px");
    expect(extractLine("data-[state=active]:font-medium")).toContain(
      "data-[state=active]:text-foreground",
    );
  });

  it("renders line tabs with working radix semantics end to end", () => {
    render(
      <Tabs defaultValue="preview">
        <TabsList variant="line">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="editor">Tools</TabsTrigger>
        </TabsList>
        <TabsContent value="preview">Preview pane</TabsContent>
        <TabsContent value="editor">Editor pane</TabsContent>
      </Tabs>,
    );

    const list = screen.getByRole("tablist");
    expect(list.className).toContain("border-(--border-subtle)");
    expect(screen.getByRole("tab", { name: "Preview" }).className).toContain(
      "after:h-0.5",
    );
    expect(screen.getByText("Preview pane")).toBeTruthy();
  });
});
