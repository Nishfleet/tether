import { defineDoc, type Tx } from "@earendil-works/pi-durable";

export type Owner = {
  space: string | null;
};

export const OwnerDoc = defineDoc<Owner>({
  kind: "tether.owner",
  version: 1,
  scope: "session",
  initial: () => ({ space: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export async function rememberSpace(tx: Tx, space: string): Promise<void> {
  const owner = await tx.doc(OwnerDoc);
  if (owner.space !== space) owner.space = space;
}
