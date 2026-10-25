// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { AssistantJobView } from "@nestor/contracts";
import { NO_SELECTION } from "./list-selection";
import { useAssistantListView } from "./use-assistant-list-view";

afterEach(cleanup);

function List(props: { request: AssistantJobView; requestId?: string }) {
  const [stage, setStage] = useState("found");
  const [text, setText] = useState("");
  const [selection, setSelection] = useState(NO_SELECTION);
  useEffect(() => setSelection(NO_SELECTION), [stage, text]);
  useAssistantListView(JSON.stringify(props.request), {
    requestId: props.requestId ?? "first",
    current: { stage: stage as "found" | "hidden", text },
    applyView(view) {
      if (view.stage) setStage(view.stage);
      if (view.text !== undefined) setText(view.text);
    },
    setSelection,
  });
  return (
    <>
      <output>
        {JSON.stringify({
          stage,
          text,
          all: selection.all,
          ids: [...selection.ids],
        })}
      </output>
      <button onClick={() => setText("Manual filter")}>Change filter</button>
    </>
  );
}

it("applies a filtered all-selection on a newly opened screen, and later manual filters clear it", async () => {
  render(
    <List
      request={{
        stage: "hidden",
        text: "Designer",
        all: true,
        selectedIds: [7],
      }}
    />,
  );
  await waitFor(() =>
    expect(JSON.parse(screen.getByRole("status").textContent)).toEqual({
      stage: "hidden",
      text: "Designer",
      all: true,
      ids: [7],
    }),
  );
  fireEvent.click(screen.getByText("Change filter"));
  await waitFor(() =>
    expect(JSON.parse(screen.getByRole("status").textContent)).toEqual({
      stage: "hidden",
      text: "Manual filter",
      all: false,
      ids: [],
    }),
  );
});

it("selects explicit jobs without a filter change and accepts a later navigation", async () => {
  const view = render(<List request={{ selectedIds: [3, 9] }} />);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain('"ids":[3,9]'),
  );
  view.rerender(<List request={{ text: "Engineer", selectedIds: [12] }} />);
  await waitFor(() =>
    expect(JSON.parse(screen.getByRole("status").textContent)).toEqual({
      stage: "found",
      text: "Engineer",
      all: false,
      ids: [12],
    }),
  );
  fireEvent.click(screen.getByText("Change filter"));
  view.rerender(
    <List
      request={{ text: "Engineer", selectedIds: [12] }}
      requestId="again"
    />,
  );
  await waitFor(() =>
    expect(JSON.parse(screen.getByRole("status").textContent)).toEqual({
      stage: "found",
      text: "Engineer",
      all: false,
      ids: [12],
    }),
  );
});
