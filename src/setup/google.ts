import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { googleBackends, GOOGLE_SCOPES, type GoogleEndpoints } from "../calendar/google.ts";
import { updateEnvFile } from "./env-file.ts";
import type { Ask } from "./prompt.ts";

export const REDIRECT = "http://127.0.0.1:8765";

export type GoogleSetup = {
  readonly ask: Ask;
  readonly print: (line: string) => void;
  readonly envFile: string;
  readonly timezone: string;
  readonly endpoints?: GoogleEndpoints;
};

export function codeFrom(pasted: string): string {
  const text = pasted.trim();
  if (!text.includes("=")) return text;
  const code = new URL(text, REDIRECT).searchParams.get("code");
  if (!code) throw new Error("no code in the pasted address");
  return code;
}

export async function connectGoogle(setup: GoogleSetup): Promise<void> {
  const clientId = await setup.ask("Google client ID: ");
  const clientSecret = await setup.ask("Google client secret (hidden): ", { secret: true });
  const client = new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: REDIRECT,
    ...(setup.endpoints?.tokenUrl ? { endpoints: { oauth2TokenUrl: setup.endpoints.tokenUrl } } : {}),
  });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SCOPES],
    code_challenge: codeChallenge as string,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  setup.print("Open this link in your browser and approve all three permissions:");
  setup.print(url);
  setup.print("The next page will fail to load. That is expected. Copy its full address from the address bar.");
  const code = codeFrom(await setup.ask("Pasted address (hidden): ", { secret: true }));
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: REDIRECT });
  if (!tokens.refresh_token) throw new Error("Google sent no refresh token. Remove this app from your Google account permissions and try again.");
  const granted = (tokens.scope ?? "").split(" ");
  const missing = GOOGLE_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) throw new Error(`missing permissions: ${missing.length}. Approve all three.`);
  const probe = googleBackends({ clientId, clientSecret, refreshToken: tokens.refresh_token }, setup.timezone, setup.endpoints);
  const now = new Date();
  await probe.calendar[0]?.list(now, new Date(now.getTime() + 86_400_000));
  await probe.contacts[0]?.find("zz");
  updateEnvFile(setup.envFile, { TETHER_GOOGLE_CLIENT_ID: clientId, TETHER_GOOGLE_CLIENT_SECRET: clientSecret, TETHER_GOOGLE_REFRESH_TOKEN: tokens.refresh_token });
  setup.print("Google is connected. Restart tether-agent to use it.");
}
