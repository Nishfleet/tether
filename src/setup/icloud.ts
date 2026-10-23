import { icloudBackends, type IcloudEndpoints } from "../calendar/icloud.ts";
import { updateEnvFile } from "./env-file.ts";
import type { Ask } from "./prompt.ts";

export type IcloudSetup = {
  readonly ask: Ask;
  readonly print: (line: string) => void;
  readonly envFile: string;
  readonly timezone: string;
  readonly endpoints?: IcloudEndpoints;
};

export async function connectIcloud(setup: IcloudSetup): Promise<void> {
  const appleId = await setup.ask("Apple ID email: ");
  const appPassword = await setup.ask("App-specific password (hidden): ", { secret: true });
  const probe = icloudBackends({ appleId, appPassword }, setup.timezone, setup.endpoints);
  const now = new Date();
  await probe.calendar[0]?.list(now, new Date(now.getTime() + 86_400_000));
  await probe.contacts[0]?.find("zz");
  updateEnvFile(setup.envFile, { TETHER_ICLOUD_APPLE_ID: appleId, TETHER_ICLOUD_APP_PASSWORD: appPassword });
  setup.print("iCloud is connected. Restart tether-agent to use it.");
}
