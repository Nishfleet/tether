import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

it("every top-level source file except the entry point can be imported without side effects", () => {
  const src = join(import.meta.dirname, "..", "src");
  const files = readdirSync(src).filter((name) => name.endsWith(".ts") && name !== "index.ts");
  const script = `for (const file of process.argv.slice(1)) await import(file); console.log("imported");`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, ...files.map((name) => join(src, name))], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "imported");
});
