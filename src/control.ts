import { type Inbound, type InboundAttachment, normalizeHandle } from "./channel.ts";
import { isLocationAttachment } from "./location.ts";

export type Verdict =
  | { readonly kind: "ignore"; readonly reason: "sender_not_allowed" | "not_direct" | "not_text" }
  | { readonly kind: "stop" }
  | { readonly kind: "resume" }
  | { readonly kind: "location"; readonly attachment: InboundAttachment }
  | { readonly kind: "chat"; readonly text: string };

export function classify(message: Inbound, allowedSender: string): Verdict {
  if (normalizeHandle(message.sender) !== normalizeHandle(allowedSender)) {
    return { kind: "ignore", reason: "sender_not_allowed" };
  }
  if (!message.direct) return { kind: "ignore", reason: "not_direct" };
  const text = message.text?.trim();
  if (!text) {
    const attachment = message.attachments?.find(isLocationAttachment);
    return attachment ? { kind: "location", attachment } : { kind: "ignore", reason: "not_text" };
  }
  const command = text.toUpperCase();
  if (command === "STOP") return { kind: "stop" };
  if (command === "RESUME") return { kind: "resume" };
  return { kind: "chat", text };
}
