// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { CountFigure } from "./count-figure";

afterEach(cleanup);

function width(node: Element | null) {
  return (node as HTMLElement | null)?.style.minWidth;
}

test("an unknown count reserves the slot a two-digit count takes, so landing moves nothing", () => {
  const { container, rerender } = render(
    <CountFigure count={0} known={false} slot="test:a" />,
  );
  const figure = container.querySelector("[data-count-figure]");
  expect(figure?.textContent).toBe("–");
  const before = width(figure);
  rerender(<CountFigure count={27} known slot="test:a" />);
  expect(figure?.textContent).toBe("27");
  expect(width(figure)).toBe(before);
  rerender(<CountFigure count={3} known slot="test:a" />);
  expect(width(figure)).toBe(before);
});

test("a slot that last showed a long number keeps that width for its placeholder", () => {
  const { container, rerender, unmount } = render(
    <CountFigure count={1234} known slot="test:b" />,
  );
  expect(width(container.querySelector("[data-count-figure]"))).toBe("5ch");
  unmount();
  const again = render(<CountFigure count={0} known={false} slot="test:b" />);
  expect(width(again.container.querySelector("[data-count-figure]"))).toBe(
    "5ch",
  );
  again.rerender(<CountFigure count={1234} known slot="test:b" />);
  expect(width(again.container.querySelector("[data-count-figure]"))).toBe(
    "5ch",
  );
  void rerender;
});
