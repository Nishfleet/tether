import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Channel, Inbound } from "./channel.ts";
import type { PhotonConfig } from "./config.ts";

type SpaceRef = readonly [id: string, phone: string];

export async function spectrumChannel(photon: PhotonConfig): Promise<Channel> {
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
      const ref: SpaceRef = [space.id, space.phone];
      yield {
        id: message.id,
        sender: message.sender?.id ?? "",
        space: JSON.stringify(ref),
        direct: space.type === "dm",
        text: message.content.type === "text" ? message.content.text : undefined,
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
