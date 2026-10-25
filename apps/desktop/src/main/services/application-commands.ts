import {
  APPLICATION_COMMANDS,
  type ApplicationCommandName,
  type ApplicationCommandOutputs,
  type ApplicationAutomationMode,
} from "@nestor/contracts";
import { executeApplicationStoreCommand } from "../routes/application-store";

const actions = {
  apply_to_jobs: "apply-jobs",
  list_application_work: "list-applications",
  applications_for_jobs: "applications-for-jobs",
  get_application_details: "get-application-details",
  open_application: "open-application",
  stop_application: "stop-application",
  send_application: "send-application",
} as const satisfies Record<ApplicationCommandName, string>;

/** Same executor as the screen's typed preload methods. */
export async function runApplicationCommand<K extends ApplicationCommandName>(
  name: K,
  input: unknown,
  instruction?: { conversationId: string; mode: ApplicationAutomationMode },
): Promise<ApplicationCommandOutputs[K]> {
  if (!Object.hasOwn(APPLICATION_COMMANDS, name))
    throw new Error("Unknown application command.");
  const parsed = APPLICATION_COMMANDS[name].input.parse(input);
  return (await executeApplicationStoreCommand(
    actions[name],
    parsed,
    instruction,
  )) as ApplicationCommandOutputs[K];
}
