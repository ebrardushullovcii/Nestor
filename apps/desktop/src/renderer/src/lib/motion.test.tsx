// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useListMoveMotion } from "./motion";

function List(props: { ids: readonly string[] }) {
  const ref = useRef<HTMLUListElement | null>(null);
  useListMoveMotion(ref, props.ids);
  return (
    <ul ref={ref}>
      {props.ids.map((id) => (
        <li key={id}>
          <button data-collection-item-id={id} type="button">
            {id}
          </button>
        </li>
      ))}
    </ul>
  );
}

const animate = vi.fn();
function setReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: reduce }));
}
function animatedRows() {
  return (animate.mock.contexts as Element[]).map((element) =>
    element.tagName === "UL" ? "list" : element.textContent,
  );
}

describe("useListMoveMotion", () => {
  beforeEach(() => {
    animate.mockClear();
    Element.prototype.animate = animate as unknown as Element["animate"];
    setReducedMotion(false);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("slides the rows under a decided row up by one slot each", () => {
    const { rerender } = render(<List ids={["a", "b", "c", "d"]} />);
    expect(animate).not.toHaveBeenCalled();

    rerender(<List ids={["a", "c", "d"]} />);

    expect(animatedRows()).toEqual(["c", "d"]);
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: "translateY(100%)" },
      { transform: "none" },
    ]);
  });

  test("fades a row that comes back and slides the rows under it down", () => {
    const { rerender } = render(<List ids={["a", "c", "d"]} />);

    rerender(<List ids={["a", "b", "c", "d"]} />);

    expect(animatedRows()).toEqual(["b", "c", "d"]);
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { transform: "translateY(-100%)" },
      { transform: "none" },
    ]);
  });

  test("fades the whole list in when the page changes", () => {
    const first = Array.from({ length: 10 }, (_, index) => `p1-${index}`);
    const second = Array.from({ length: 10 }, (_, index) => `p2-${index}`);
    const { rerender } = render(<List ids={first} />);

    rerender(<List ids={second} />);

    expect(animatedRows()).toEqual(["list"]);
  });

  test("does nothing when the person asks for reduced motion", () => {
    setReducedMotion(true);
    const { rerender } = render(<List ids={["a", "b", "c"]} />);

    rerender(<List ids={["a", "c"]} />);

    expect(animate).not.toHaveBeenCalled();
  });
});
