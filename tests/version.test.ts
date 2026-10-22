import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

it("--version prints the package.json version and exits 0 without any configuration", () => {
  const root = join(import.meta.dirname, "..");
  const expected = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const out = execFileSync(process.execPath, ["--no-warnings", join(root, "src/index.ts"), "--version"], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(out, `${expected}\n`);
});
