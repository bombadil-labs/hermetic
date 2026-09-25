import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { check, intrinsics } from "../src/index.ts";

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

  it("lists every built-in intrinsics returns", () => {
    const table = readme.slice(readme.indexOf("| Category | Included |"), readme.indexOf("Pass it `globalThis`"));
    const included = table
      .split("\n")
      .slice(2)
      .flatMap((row) => [...(row.split("|")[2] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]));
    const keys = Object.keys(intrinsics(globalThis));
    const errors = keys.filter((name) => name.endsWith("Error"));
    expect([...included, ...errors].sort()).toEqual([...keys].sort());
    expect(table).toContain("`Math.random`");
  });
});
