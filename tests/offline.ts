import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { MemoryDoc, type Note, StateDoc } from "../src/docs.ts";
import { DATABASE_FILE } from "../src/main.ts";

export async function commitStopWithoutAbort(stateDir: string): Promise<void> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(stateDir, DATABASE_FILE)),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  await harness.commit(async (tx) => {
    const state = await tx.doc(StateDoc);
    state.stopped = true;
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
}

export async function seedNote(file: string, note: Note): Promise<void> {
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  await harness.commit(async (tx) => {
    (await tx.doc(MemoryDoc)).notes.push(note);
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
}
