import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Channel, Inbound, InboundAttachment } from "./channel.ts";
import type { PhotonConfig } from "./config.ts";
import { linkAttachment } from "./location.ts";
import type { Log } from "./log.ts";

type SpaceRef = readonly [id: string, phone: string];

type AttachmentInfo = { fileName: string; mimeType: string; guid: string; totalBytes: number };

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export async function spectrumChannel(photon: PhotonConfig, log: Log): Promise<Channel> {
  const app = await Spectrum({
    projectId: photon.projectId,
    projectSecret: photon.projectSecret,
    providers: [imessage.config()],
    telemetry: false,
  });
  const provider = imessage(app);

  async function* messages(): AsyncGenerator<Inbound> {
    for await (const [space, message] of app.messages) {
      if (message.direction !== "inbound" || !imessage.is(space)) continue;
      if (!space.phone) {
        log("skipped", { id: message.id, reason: "no_phone" });
        continue;
      }
      const ref: SpaceRef = [space.id, space.phone];
      const phone = space.phone;
      const described = (message as { attachmentMetadata?: readonly AttachmentInfo[] }).attachmentMetadata ?? [];
      const attachments: InboundAttachment[] = described.map((info) => ({
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.totalBytes,
        read: async () => {
          const found = await provider.getAttachment(info.guid, phone);
          if (!found) throw new Error("attachment not found");
          return found.read();
        },
      }));
      try {
        const fields = message as unknown as Record<string, unknown>;
        const miniApp = fields.miniApp as { url?: unknown } | undefined;
        const miniAppUrl = str(miniApp?.url);
        const sources = [message.content.type === "text" ? message.content.text : undefined, miniAppUrl, str(fields.nativeText), str(fields.subject)];
        const shared = linkAttachment(...sources);
        if (shared) attachments.push(shared);
        if (message.content.type !== "text") {
          log("inbound_content", {
            id: message.id,
            type: message.content.type,
            attachments: attachments.length,
            balloon: str(fields.balloonBundleId) ?? "",
            miniApp: miniApp !== undefined,
            miniAppUrl: miniAppUrl !== undefined,
            nativeTextChars: str(fields.nativeText)?.length ?? 0,
            subjectChars: str(fields.subject)?.length ?? 0,
            itemType: str(fields.itemType) ?? "",
            sharedLink: shared !== undefined,
            keys: Object.keys(fields).sort().join(","),
          });
        }
      } catch (error) {
        log("inbound_shape_failed", { id: message.id, error: error instanceof Error ? error.name : "unknown" });
      }
      yield {
        id: message.id,
        sender: message.sender?.id ?? "",
        space: JSON.stringify(ref),
        direct: space.type === "dm",
        text: message.content.type === "text" ? message.content.text : undefined,
        attachments,
      };
    }
  }

  return {
    messages,
    send: async (space, text) => {
      const [id, phone] = JSON.parse(space) as SpaceRef;
      await (await provider.space.get(id, { phone })).send(text);
    },
    stop: () => app.stop(),
  };
}
