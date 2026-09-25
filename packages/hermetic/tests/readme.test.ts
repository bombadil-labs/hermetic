import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { check, DEFAULT_GROUND_ALLOW, DEFAULT_GROUND_DENY } from "../src/index.ts";

const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("README.md", () => {
  it("shows exactly what check returns for its first example", () => {
    const example = /```ts\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";
    const source = /check\(`([\s\S]*?)`\);/.exec(example)?.[1];
    const documented = /\/\/ \{\n([\s\S]*?)\/\/ \}/.exec(example)?.[1]?.replace(/^\/\/ /gm, "");
    expect(source).toBeDefined();
    expect(documented).toBeDefined();
    expect(check(source ?? "")).toEqual(new Function(`return {${documented}}`)());
  });

  it("lists every default allowed global and denied member", () => {
    const table = readme.slice(readme.indexOf("| Category | Allowed |"), readme.indexOf("Anything not listed isn't allowed"));
    const allowed = table
      .split("\n")
      .slice(2)
      .flatMap((row) => [...(row.split("|")[2] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]));
    const errors = DEFAULT_GROUND_ALLOW.filter((name) => name.endsWith("Error"));
    expect([...allowed, ...errors].sort()).toEqual([...DEFAULT_GROUND_ALLOW].sort());
    for (const path of DEFAULT_GROUND_DENY) expect(table).toContain(`\`${path}\``);
  });
});
