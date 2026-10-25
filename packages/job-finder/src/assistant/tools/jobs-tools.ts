import { NonEmptyStringSchema } from "@nestor/contracts";
import { z } from "zod";
import { defineTool, json } from "../tool-kit";

const Id = NonEmptyStringSchema.max(200);

export const checkSourceTool = defineTool({
  name: "check_source",
  group: "jobs",
  description:
    "Runs a source check (the agent learns how to read the site) for one source by id. Optional: sources are searched without one.",
  parameters: json.object({ sourceId: json.string() }, ["sourceId"]),
  input: z.object({ sourceId: Id }),
  label: () => "Checking a job source",
  effect: "external",
  async execute(input, { ports, session }) {
    session.assertCurrent();
    await ports.checkSource(input.sourceId, { signal: session.signal });
    return {
      summary: "The source check finished; get_site shows its result.",
    };
  },
});

export const jobsTools = [checkSourceTool];
