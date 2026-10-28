# Sidebar assistant navigation

The app-wide chat can open a destination even when the person moves away while the model is thinking. The renderer acknowledges the destination it actually displays; a request for the screen already showing keeps its current view.

## Sub-features

- Open a destination from chat and receive its displayed-state acknowledgement.
- Keep navigation accurate after the person changes screens during a reply.
- Preserve the view when the destination is already showing.

## How to get to it (user POV)

Open the assistant in the window header. The conversation stays open across sidebar destinations.

## Driving it with verify-nestor

Use an isolated instance with live AI. Open Shortlisted, open the assistant, type `Open my shortlisted jobs.` and press Send. Immediately click Applications in the sidebar. Wait for Shortlisted to appear again. Capture the send-time screen, Applications while the reply runs, and the resulting Shortlisted screen; retain the open_route event and saved conversation as evidence. This exercises the stale-send-context case without changing a real workspace or sending an application.

For a same-screen request, send the same instruction while remaining on Shortlisted. Check that the renderer acknowledges it and preserves the current view. Do not report this second entry point as verified just because the first passed.

## Gotchas

The user move must happen before the model opens the destination. If the model finishes first, repeat with a fresh message; that run did not exercise stale context. Opening a route is proven by the displayed heading and the acknowledged tool result, not by the assistant saying it opened something.
