import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { MemoryDoc, NOTE_CHARS, NOTE_LIMIT } from "./docs.ts";
import { failure, text } from "./tool.ts";

const nextMemoryId = (ids: readonly string[]) =>
  ids.reduce((max, id) => {
    const parsed = Number(id.slice(1));
    return Number.isSafeInteger(parsed) && parsed > max ? parsed : max;
  }, 0) + 1;

const save = defineTool({
  name: "memory_save",
  description: `Save one short note to your own long-term memory so you still know it in later conversations. At most ${NOTE_CHARS} characters.`,
  parameters: Type.Object({ note: Type.String({ minLength: 1, maxLength: NOTE_CHARS }) }),
  replay: "safe",
  execute: async (args, api, context) => {
    const outcome = await api.commit(async (tx) => {
      const { notes } = await tx.doc(MemoryDoc);
      const same = notes.find((note) => note.text === args.note);
      if (same) return same.id;
      if (notes.length >= NOTE_LIMIT) return undefined;
      const id = `n${nextMemoryId(notes.map((note) => note.id))}`;
      notes.push({ id, text: args.note, at: api.now() });
      return id;
    }, context);
    return outcome !== undefined ? text(`Saved as ${outcome}.`) : failure(`Memory is full (${NOTE_LIMIT} notes). Forget one first.`);
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
    return removed ? text(`Forgot ${args.id}.`) : failure(`No note ${args.id}.`);
  },
});

export function createMemoryExtension(tasks: NonNullable<Extension["tasks"]>): Extension {
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
    tasks,
  });
}
