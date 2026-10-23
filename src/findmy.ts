import { type AdvancedIMessage, createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import { cloud } from "spectrum-ts";
import type { LiveLocation, Locations } from "./channel.ts";
import { cleanLabel } from "./location.ts";
import type { Log } from "./log.ts";

type Issued = Awaited<ReturnType<typeof cloud.issueImessageTokens>>;

export type FindMyDeps = {
  readonly issue: (projectId: string, projectSecret: string) => Promise<Issued>;
  readonly open: (address: string, token: string) => AdvancedIMessage;
  readonly now: () => number;
  readonly sharedAddress: string;
};

export const SHARED_ADDRESS = "imessage.spectrum.photon.codes:443";
export const TOKEN_SHARE = 0.8;
export const MIN_TOKEN_MS = 30000;

export const photonDeps = (): FindMyDeps => ({
  issue: (projectId, projectSecret) => cloud.issueImessageTokens(projectId, projectSecret),
  open: (address, token) => createGrpcClient({ address, tls: true, retry: true, autoIdempotency: true, token: async () => token }),
  now: () => Date.now(),
  sharedAddress: process.env.SPECTRUM_IMESSAGE_ADDRESS ?? SHARED_ADDRESS,
});

function target(data: Issued, sharedAddress: string): { address: string; token: string } {
  if (data.type === "shared") return { address: sharedAddress, token: data.token };
  const [instance] = Object.entries(data.auth);
  if (!instance) throw new Error("no iMessage line");
  return { address: `${instance[0]}.imsg.photon.codes:443`, token: instance[1] };
}

export type FindMyOptions = {
  readonly projectId: string;
  readonly projectSecret: string;
  readonly owner: string;
  readonly log: Log;
  readonly deps?: FindMyDeps;
};

export function createFindMy(options: FindMyOptions): Locations & { close(): Promise<void> } {
  const { projectId, projectSecret, owner, log } = options;
  const deps = options.deps ?? photonDeps();
  let session: { client: AdvancedIMessage; until: number } | undefined;

  const client = async (): Promise<AdvancedIMessage> => {
    const now = deps.now();
    if (session && now < session.until) return session.client;
    const data = await deps.issue(projectId, projectSecret);
    const { address, token } = target(data, deps.sharedAddress);
    const previous = session?.client;
    session = { client: deps.open(address, token), until: now + Math.max(MIN_TOKEN_MS, data.expiresIn * 1000 * TOKEN_SHARE) };
    await previous?.close().catch(() => undefined);
    return session.client;
  };

  return {
    current: async (): Promise<LiveLocation | undefined> => {
      try {
        const found = await (await client()).locations.get(owner);
        if (typeof found.latitude !== "number" || typeof found.longitude !== "number") {
          log("findmy_current", { found: false, type: found.locationType });
          return undefined;
        }
        const now = deps.now();
        const at = found.locationTimestamp?.getTime() ?? now;
        log("findmy_current", { found: true, type: found.locationType, ageSeconds: Math.max(0, Math.round((now - at) / 1000)) });
        return { latitude: found.latitude, longitude: found.longitude, label: cleanLabel(found.shortAddress ?? found.name), at };
      } catch (error) {
        log("findmy_failed", { step: "get", error: error instanceof Error ? error.name : "unknown" });
        return undefined;
      }
    },
    request: async (space: string): Promise<boolean> => {
      try {
        const [chat] = JSON.parse(space) as [string, string];
        const receipt = await (await client()).locations.request(chat, owner);
        log("findmy_request", { status: receipt.status });
        return true;
      } catch (error) {
        log("findmy_failed", { step: "request", error: error instanceof Error ? error.name : "unknown" });
        return false;
      }
    },
    close: async () => {
      const open = session?.client;
      session = undefined;
      await open?.close().catch(() => undefined);
    },
  };
}
