import { type Inbound, type InboundAttachment, normalizeHandle } from "./channel.ts";
import { isLocationAttachment, isMapsLinkOnly } from "./location.ts";

export type Verdict =
  | { readonly kind: "ignore"; readonly reason: "sender_not_allowed" | "not_direct" | "not_text" }
  | { readonly kind: "stop" }
  | { readonly kind: "resume" }
  | { readonly kind: "yes"; readonly text: string }
  | { readonly kind: "no"; readonly text: string }
  | { readonly kind: "location"; readonly attachment: InboundAttachment }
  | { readonly kind: "chat"; readonly text: string };

export function classify(message: Inbound, allowedSender: string): Verdict {
  if (normalizeHandle(message.sender) !== normalizeHandle(allowedSender)) {
    return { kind: "ignore", reason: "sender_not_allowed" };
  }
  if (!message.direct) return { kind: "ignore", reason: "not_direct" };
  const text = message.text?.trim();
  const attachment = message.attachments?.find(isLocationAttachment);
  if (attachment && (!text || isMapsLinkOnly(text))) return { kind: "location", attachment };
  if (!text) return { kind: "ignore", reason: "not_text" };
  const command = text.toUpperCase();
  if (command === "STOP") return { kind: "stop" };
  if (command === "RESUME") return { kind: "resume" };
  if (command === "YES") return { kind: "yes", text };
  if (command === "NO") return { kind: "no", text };
  return { kind: "chat", text };
}
