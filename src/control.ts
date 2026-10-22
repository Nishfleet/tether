import { normalizeHandle, type Inbound } from "./channel.ts";

export type Verdict =
  | { readonly kind: "ignore"; readonly reason: "sender_not_allowed" | "not_direct" | "not_text" }
  | { readonly kind: "stop" }
  | { readonly kind: "resume" }
  | { readonly kind: "chat"; readonly text: string };

export function classify(message: Inbound, allowedSender: string): Verdict {
  if (normalizeHandle(message.sender) !== normalizeHandle(allowedSender)) {
    return { kind: "ignore", reason: "sender_not_allowed" };
  }
  if (!message.direct) return { kind: "ignore", reason: "not_direct" };
  const text = message.text?.trim();
  if (!text) return { kind: "ignore", reason: "not_text" };
  const command = text.toUpperCase();
  if (command === "STOP") return { kind: "stop" };
  if (command === "RESUME") return { kind: "resume" };
  return { kind: "chat", text };
}
