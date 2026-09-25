import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GroundBootstrapError, loadGround } from "../../src/ground/bootstrap.ts";
import { DEFAULT_GROUND, type Ground } from "@bombadil/hermetic";
import { sealed } from "../../src/rules/sealed.ts";
import { fixture, repoRoot } from "../helpers.ts";

const load = (file: string): Ground => loadGround(file, sealed);
const summary = (ground: Ground) => ({
  names: [...ground.names].sort(),
  deny: ground.deny.map((segments) => segments.join(".")).sort(),
});

describe("loading a ground bootstrap", () => {
  it("reads allow keys and deny paths from an exported 'ground'", () => {
    expect(summary(load(fixture("clock.ground.ts")))).toEqual({
      names: ["Date", "Math", "Object"],
      deny: ["Date.now", "Math.random", "Object.prototype.toString"],
    });
  });

  it("falls back to the default export", () => {
    expect(summary(load(fixture("default-export.ground.ts")))).toEqual({ names: ["JSON"], deny: [] });
  });

  it("follows export specifiers", () => {
    expect(summary(load(fixture("specifier.ground.ts")))).toEqual({ names: ["Array"], deny: [] });
  });

  it("accepts an @hermetic JSDoc tag on an expression-bodied arrow", () => {
    expect(summary(load(fixture("jsdoc.ground.ts")))).toEqual({ names: ["Map"], deny: [] });
  });

  it("erases TypeScript syntax before running the bootstrap", () => {
    expect(summary(load(fixture("typed.ground.ts")))).toEqual({ names: ["JSON", "Math", "twice"], deny: ["Math.random"] });
  });

  it("loads plain JavaScript", () => {
    expect(summary(load(fixture("plain.ground.mjs")))).toEqual({ names: ["Math", "Set"], deny: ["Math.random"] });
  });

  it("only checks the bootstrap, not other functions in the file", () => {
    expect(summary(load(fixture("other-errors.ground.ts")))).toEqual({ names: ["String"], deny: [] });
  });

  it("matches the default ground when the default is spelled as a bootstrap", () => {
    expect(summary(load(path.join(repoRoot, "examples/hermetic.ground.ts")))).toEqual(summary(DEFAULT_GROUND));
  });
});

describe("refusing a ground bootstrap", () => {
  const refuses = (name: string, message: RegExp) => {
    const attempt = () => load(fixture(name));
    expect(attempt).toThrow(GroundBootstrapError);
    expect(attempt).toThrow(message);
  };

  it("when the file is missing", () => refuses("missing.ground.ts", /Cannot read the ground bootstrap/));
  it("when the file does not parse", () => refuses("syntax-error.ground.ts", /Cannot parse the ground bootstrap/));
  it("when there is no bootstrap export", () => refuses("no-bootstrap.ground.ts", /No ground bootstrap found/));
  it("when the bootstrap is not marked hermetic", () => refuses("unmarked.ground.ts", /must be marked hermetic/));

  it("when the bootstrap is not hermetic, listing the problems", () =>
    refuses("free-variable.ground.ts", /is not hermetic, so it will not be run:\n.*'extra' is a free variable/));

  it("even when the problem is suppressed with an eslint-disable comment", () =>
    refuses("suppressed.ground.ts", /'extra' is a free variable/));

  it("when the bootstrap throws, pointing at the throw", () =>
    refuses("throws.ground.ts", /threw at .*throws\.ground\.ts:3:9: no ground today/));

  it("when the bootstrap throws on its first line, with the column in the original file", () => {
    const file = fixture("throws-first-line.ground.ts");
    const column = fs.readFileSync(file, "utf8").indexOf("new Error") + 1;
    expect(() => load(file)).toThrow(new RegExp(`threw at .*throws-first-line\\.ground\\.ts:1:${column}: early`));
  });

  it("when the bootstrap does not return in time", () => refuses("loops.ground.ts", /did not return within 1000ms/));
  it("when the bootstrap uses syntax that cannot be erased", () =>
    refuses("enum.ground.ts", /An enum cannot be erased to plain JavaScript.*enum\.ground\.ts:3:3/));
  it("when the bootstrap returns a promise", () => refuses("async.ground.ts", /must return its ground synchronously/));
  it("when the bootstrap compiles strings", () => refuses("codegen.ground.ts", /Code generation from strings disallowed/));
  it("when allow is not an object", () => refuses("bad-shape.ground.ts", /must return an allow object/));
  it("when a deny path is malformed", () => refuses("bad-deny.ground.ts", /Invalid deny path 'Math\.\.random'/));
});

describe("caching", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-ground-"));
  const file = path.join(dir, "hermetic.ground.ts");
  const write = (names: string[], mtimeSeconds: number) => {
    const allow = names.map((name) => `${name}: realm.${name}`).join(", ");
    fs.writeFileSync(file, `export function ground(realm: typeof globalThis) {\n  "use hermetic";\n  return { allow: { ${allow} } };\n}\n`);
    fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  };
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reuses the ground until the file changes", () => {
    write(["Math"], 1_000_000);
    const first = load(file);
    expect(load(file)).toBe(first);

    fs.utimesSync(file, 1_000_010, 1_000_010);
    expect(load(file)).toBe(first);

    write(["JSON", "Array"], 1_000_020);
    const second = load(file);
    expect(second).not.toBe(first);
    expect(summary(second).names).toEqual(["Array", "JSON"]);
  });
});
