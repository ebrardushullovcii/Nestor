// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AiAccountNeed, JobChange } from "@nestor/contracts";
import { afterEach, expect, test, vi } from "vitest";

import { AiAccountNeedItem } from "./ai-account-need";
import { AiServicePausedLine } from "./ai-service-paused-line";
import { useNeedsYouCount } from "./use-needs-you-count";

// Synthetic: no real service or account.
const outOfCredit: AiAccountNeed = {
  id: "0123456789abcdef",
  provider: "https://model.example.test",
  reason: "funding",
  owner: "person",
  providerMessage:
    "Insufficient balance. Top up at https://model.example.test/console/account-test/billing?credits=1.",
  actionUrl:
    "https://model.example.test/console/account-test/billing?credits=1",
  since: "2026-11-27T03:45:31.000Z",
};

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "nestor");
});

function bridge(needs: AiAccountNeed[]) {
  const listeners = new Set<(change: JobChange) => void>();
  const aiAccount = {
    list: vi.fn(() => Promise.resolve(needs)),
    open: vi.fn(() => Promise.resolve(true)),
    check: vi.fn(() => Promise.resolve(true)),
  };
  Object.assign(window, {
    nestor: {
      needsYou: {
        run: vi.fn(() =>
          Promise.resolve({
            question: 1,
            sign_in: 0,
            captcha: 0,
            mfa: 0,
            saved: 0,
          }),
        ),
        aiAccount,
      },
      jobs: {
        onChange: (listener: (change: JobChange) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  return {
    aiAccount,
    change: () => {
      for (const listener of listeners)
        listener({ cause: "application", stages: [], ids: [], searchId: null });
    },
  };
}

test("names the top-up as the person's step, quotes the provider and opens its own link", async () => {
  const { aiAccount } = bridge([outOfCredit]);
  render(<AiAccountNeedItem need={outOfCredit} />);
  expect(
    screen.getByRole("heading", { name: "Top up your AI account" }),
  ).toBeTruthy();
  expect(screen.getByText(outOfCredit.providerMessage!)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open the top-up page" }));
  await waitFor(() =>
    expect(aiAccount.open).toHaveBeenCalledWith(outOfCredit.id),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "I've done it, check now" }),
  );
  await waitFor(() => expect(aiAccount.check).toHaveBeenCalledOnce());
  expect(await screen.findByRole("status")).toBeTruthy();
});

test("a key or access refusal says its own step and offers no link it was not given", () => {
  bridge([]);
  render(
    <AiAccountNeedItem
      need={{
        ...outOfCredit,
        reason: "authentication",
        providerMessage: "Invalid API key.",
        actionUrl: null,
      }}
    />,
  );
  expect(
    screen.getByRole("heading", {
      name: "Fix the API key for your AI account",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Open/u })).toBeNull();
});

test("the Needs you badge counts the AI account step once, and drops it when it resolves", async () => {
  const needs = [outOfCredit];
  const { aiAccount, change } = bridge(needs);
  const { result } = renderHook(() => useNeedsYouCount());
  await waitFor(() => expect(result.current).toBe(2));
  aiAccount.list.mockResolvedValue([]);
  act(() => change());
  await waitFor(() => expect(result.current).toBe(1));
});

test("Nestor's bundled key is no Needs you step: the badge leaves it out and the app says its AI is paused", async () => {
  bridge([
    {
      ...outOfCredit,
      owner: "nestor",
      providerMessage: null,
      actionUrl: null,
    },
  ]);
  const { result } = renderHook(() => useNeedsYouCount());
  render(<AiServicePausedLine />);
  expect(
    await screen.findByText(
      "Nestor's AI service is paused. Your work continues by itself when it is back.",
    ),
  ).toBeTruthy();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(result.current).toBe(1);
});
