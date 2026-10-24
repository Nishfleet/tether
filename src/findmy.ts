import { type AdvancedIMessage, AuthenticationError, createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
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
  let client: Promise<AdvancedIMessage> | undefined;
  let closed = false;

  const connect = (): Promise<AdvancedIMessage> => {
    client ??= deps.issue(projectId, projectSecret).then((data) => {
      if (closed) throw new Error("closed");
      const { address, token } = target(data, deps.sharedAddress);
      return deps.open(address, token);
    });
    const opening = client;
    opening.catch(() => {
      if (client === opening) client = undefined;
    });
    return opening;
  };

  // A call refused as unauthenticated holds an expired token: drop the client, issue a new token, and try once more.
  const lease = async <T>(use: (client: AdvancedIMessage) => Promise<T>): Promise<T> => {
    if (closed) throw new Error("closed");
    const first = connect();
    try {
      return await use(await first);
    } catch (error) {
      if (closed || !(error instanceof AuthenticationError)) throw error;
      if (client === first) client = undefined;
      await first.then((old) => old.close()).catch(() => undefined);
      return use(await connect());
    }
  };

  return {
    current: async (): Promise<LiveLocation | undefined> => {
      try {
        const found = await lease((client) => client.locations.get(owner));
        const now = deps.now();
        const dated = found.locationTimestamp?.getTime();
        const usable = typeof found.latitude === "number" && typeof found.longitude === "number" && (dated !== undefined || found.locationType === "live");
        if (!usable || typeof found.latitude !== "number" || typeof found.longitude !== "number") {
          log("findmy_current", { found: false, type: found.locationType });
          return undefined;
        }
        const at = dated ?? now;
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
        const receipt = await lease((client) => client.locations.request(chat, owner));
        log("findmy_request", { status: receipt.status, reason: receipt.reason !== undefined });
        return true;
      } catch (error) {
        log("findmy_failed", { step: "request", error: error instanceof Error ? error.name : "unknown" });
        return false;
      }
    },
    close: async () => {
      closed = true;
      const open = client;
      client = undefined;
      // A token still being issued is not waited for: connect() refuses to open a client once closed.
      void open?.then((old) => old.close()).catch(() => undefined);
    },
  };
}
