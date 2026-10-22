import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { MemoryDoc, NOTE_CHARS, NOTE_LIMIT } from "./docs.ts";

const noteId = (note: string) => `n${createHash("sha256").update(note).digest("hex").slice(0, 8)}`;

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

const save = defineTool({
  name: "memory_save",
  description: `Save one short note to your own long-term memory so you still know it in later conversations. At most ${NOTE_CHARS} characters.`,
  parameters: Type.Object({ note: Type.String({ minLength: 1, maxLength: NOTE_CHARS }) }),
  replay: "safe",
  execute: async (args, api, context) => {
    const id = noteId(args.note);
    const outcome = await api.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc);
      if (memory.notes.some((note) => note.id === id)) return "saved";
      if (memory.notes.length >= NOTE_LIMIT) return "full";
      memory.notes.push({ id, text: args.note, at: api.now() });
      return "saved";
    }, context);
    return outcome === "saved" ? text(`Saved as ${id}.`) : { ...text(`Memory is full (${NOTE_LIMIT} notes). Forget one first.`), isError: true };
  },
});

const forget = defineTool({
  name: "memory_forget",
  description: "Delete one saved note by its id, as shown in your memory.",
  parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
  replay: "safe",
  execute: async (args, api, context) => {
    const removed = await api.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc);
      const index = memory.notes.findIndex((note) => note.id === args.id);
      if (index < 0) return false;
      memory.notes.splice(index, 1);
      return true;
    }, context);
    return removed ? text(`Forgot ${args.id}.`) : { ...text(`No note ${args.id}.`), isError: true };
  },
});

export function createMemoryExtension(tasks: Extension["tasks"]): Extension {
  return defineExtension({
    name: "tether",
    tools: [save, forget],
    sections: [
      section("memory", async (input, context) => {
        const memory = await input.read.snapshot(MemoryDoc, context);
        if (!memory || memory.notes.length === 0) return "No saved notes yet.";
        return memory.notes.map((note) => `${note.id}: ${note.text}`).join("\n");
      }),
    ],
    ...(tasks ? { tasks } : {}),
  });
}
