// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SiteIcon, resetSiteIconsForTest } from "./site-icon";

const ICON = "data:image/png;base64,iVBORw0KGgo=";
let changed: (() => void) | null = null;
const get = vi.fn();
const previous = window.nestor;

beforeEach(() => {
  resetSiteIconsForTest();
  get.mockReset();
  changed = null;
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      browser: {
        siteIcons: {
          get,
          onChanged: (listener: () => void) => {
            changed = listener;
            return () => undefined;
          },
        },
      },
    },
  });
});
afterEach(() => {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: previous,
  });
});

it("shows the globe until the site's cached icon arrives, in one batch per tick", async () => {
  get.mockResolvedValue({ icons: { "https://a.test": ICON } });
  const { container } = render(
    <>
      <SiteIcon url="https://a.test/jobs" />
      <SiteIcon url="https://a.test/other" />
      <SiteIcon url="https://b.test/" />
      <SiteIcon url="about:blank" />
    </>,
  );
  expect(container.querySelectorAll("[data-site-icon=none]")).toHaveLength(4);
  await act(async () => {
    await Promise.resolve();
  });
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith({
    urls: ["https://a.test", "https://b.test"],
  });
  const images = container.querySelectorAll("img[data-site-icon]");
  expect(images).toHaveLength(2);
  expect(images[0]!.getAttribute("src")).toBe(ICON);
  // Decorative: the site's name is always written beside it.
  expect(screen.queryAllByRole("img")).toHaveLength(0);
  expect(container.querySelectorAll("[data-site-icon=none]")).toHaveLength(2);
});

it("asks again when main says the cache changed", async () => {
  get.mockResolvedValueOnce({ icons: {} });
  const { container } = render(<SiteIcon url="https://c.test/" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(container.querySelector("img")).toBeNull();
  get.mockResolvedValueOnce({ icons: { "https://c.test": ICON } });
  await act(async () => {
    changed?.();
    await Promise.resolve();
  });
  expect(get).toHaveBeenCalledTimes(2);
  expect(container.querySelector("img")?.getAttribute("src")).toBe(ICON);
});
