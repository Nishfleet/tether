import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const SALT_FILE = "log-salt";

export function loadSalt(stateDir: string): string {
  const path = join(stateDir, SALT_FILE);
  try {
    writeFileSync(path, randomBytes(16).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(path, "utf8");
}
