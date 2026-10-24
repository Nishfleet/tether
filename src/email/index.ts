import type { GoogleConfig } from "../calendar/config.ts";
import type { GoogleEndpoints } from "../calendar/google.ts";
import { gmailBackend } from "./gmail.ts";
import type { EmailOptions } from "./tools.ts";

export function openEmail(config: GoogleConfig | undefined, timezone: string, endpoints: GoogleEndpoints = {}): EmailOptions | undefined {
  if (!config) return undefined;
  return { backend: gmailBackend(config, endpoints), timezone };
}
