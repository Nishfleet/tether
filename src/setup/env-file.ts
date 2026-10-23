import { chmodSync, chownSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_ENV_FILE = "/etc/tether/calendar.env";
export const SERVICE_GROUP = "tether";

export function parseEnv(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) entries.set(match[1] as string, match[2] as string);
  }
  return entries;
}

export function renderEnv(entries: ReadonlyMap<string, string>): string {
  return `${[...entries].map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

export function groupId(name: string, groupFile = "/etc/group"): number | undefined {
  if (!existsSync(groupFile)) return undefined;
  const row = readFileSync(groupFile, "utf8")
    .split("\n")
    .map((line) => line.split(":"))
    .find((fields) => fields[0] === name);
  return row?.[2] === undefined ? undefined : Number(row[2]);
}

export function updateEnvFile(path: string, updates: Readonly<Record<string, string>>, group: number | undefined = groupId(SERVICE_GROUP)): void {
  for (const [name, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(value) || value.length === 0) throw new Error(`refusing to write ${name}`);
  }
  const existing = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : new Map<string, string>();
  const merged = new Map([...existing, ...Object.entries(updates)]);
  const staged = join(dirname(path), `.${process.pid}.calendar.env.tmp`);
  writeFileSync(staged, renderEnv(merged), { mode: 0o600 });
  const owner = existsSync(path) ? statSync(path) : undefined;
  if (process.getuid?.() === 0) chownSync(staged, owner?.uid ?? 0, owner?.gid ?? group ?? 0);
  chmodSync(staged, 0o640);
  renameSync(staged, path);
}
