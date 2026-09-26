import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { build, type Plugin, type Rolldown } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { type UnliftPlugin, unliftPlugin } from "../src/build.ts";
import plugin from "../src/index.ts";
import { Mapped, sourceMap } from "../src/mapped.ts";
import { unlift } from "../src/unlift.ts";

/** Applies `prefer-hermetic`'s fixes, with or without lift. */
function fix(code: string, filename: string, lift: boolean): string {
  return new Linter().verifyAndFix(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { hermetic: plugin },
        rules: { "hermetic/prefer-hermetic": ["error", { lift }] },
      },
    ],
    { filename },
  ).output;
}

/** The 1-based line of `code` that holds `text`, and the column where it starts. */
function find(code: string, text: string): { line: number; column: number } {
  const index = code.indexOf(text);
  if (index === -1) throw new Error(`'${text}' is not in the code`);
  const before = code.slice(0, index).split("\n");
  return { line: before.length, column: before.at(-1)?.length ?? 0 };
}

describe("source maps", () => {
  it("map copied text to where it came from, and new text to what it stands for", () => {
    const source = "alpha beta\ngamma delta\n";
    const moved = Mapped.join([Mapped.copy(source, [11, 23]), Mapped.place("new ", 6), Mapped.copy(source, [0, 11])]);
    expect(moved.text).toBe("gamma delta\nnew alpha beta\n");
    const map = new TraceMap(sourceMap(moved, source, "words.txt"));
    const from = (line: number, column: number) => {
      const { line: sourceLine, column: sourceColumn } = originalPositionFor(map, { line, column });
      return { line: sourceLine, column: sourceColumn };
    };
    expect(from(1, 0)).toEqual({ line: 2, column: 0 });
    expect(from(1, 6)).toEqual({ line: 2, column: 6 });
    expect(from(2, 0)).toEqual({ line: 1, column: 6 });
    expect(from(2, 4)).toEqual({ line: 1, column: 0 });
    expect(from(2, 10)).toEqual({ line: 1, column: 6 });
  });

  it("map each line of an unlifted body back to its line in the core", () => {
    const original = [
      `const LIMIT = 100;`,
      ``,
      `export const check = (n: number) => {`,
      `  if (n > LIMIT) {`,
      `    throw new RangeError("over the limit");`,
      `  }`,
      `  return n;`,
      `};`,
    ].join("\n");
    const lifted = fix(original, "limits.ts", true);
    const result = unlift(lifted, "limits.ts", { sourceMap: true });
    expect(result.code).toBe(original);
    if (!result.map) throw new Error("no source map");
    expect(result.map.sourcesContent).toEqual([lifted]);
    const map = new TraceMap(result.map);
    for (const text of ["if (n >", "throw new", `"over the limit"`, "return n;"]) {
      const at = find(result.code, text);
      const mapped = originalPositionFor(map, at);
      expect({ line: mapped.line, column: mapped.column }, text).toEqual(find(lifted, text));
    }
  });
});

describe("unliftPlugin", () => {
  const transform = (unlifter: UnliftPlugin, code: string, id: string) => {
    const warnings: string[] = [];
    const result = unlifter.transform.handler.call({ warn: (message) => warnings.push(message) }, code, id);
    return { result, warnings };
  };
  const lifted = fix(`const RATE = 0.2;\nexport const price = (total: number) => total * (1 - RATE);\n`, "price.ts", true);

  it("unlifts the lifted modules it is given, with a source map", () => {
    const { result, warnings } = transform(unliftPlugin(), lifted, "/app/src/price.ts");
    expect(result?.code).toBe(`const RATE = 0.2;\nexport const price = (total: number) => total * (1 - RATE);\n`);
    expect(result?.map.sources).toEqual(["/app/src/price.ts"]);
    expect(warnings).toEqual([]);
  });

  it("leaves other modules as they are", () => {
    const unlifter = unliftPlugin();
    expect(transform(unlifter, lifted, "/app/src/styles.css").result).toBeNull();
    expect(transform(unlifter, lifted, "/app/node_modules/price/index.ts").result).toBeNull();
    expect(transform(unlifter, lifted, "C:\\app\\node_modules\\price\\index.ts").result).toBeNull();
    expect(transform(unlifter, lifted, "/app/src/price.ts?raw").result).toBeNull();
    expect(transform(unlifter, `export const price = (total: number) => total * 0.8;\n`, "/app/src/price.ts").result).toBeNull();
    const marked = `export function price(total: number) {\n  "use hermetic";\n  return total * 0.8;\n}\n`;
    expect(transform(unlifter, marked, "/app/src/price.ts").result).toBeNull();
  });

  it("takes include and exclude patterns", () => {
    const unlifter = unliftPlugin({ include: /\/src\/.*\.ts$/, exclude: /\.test\.ts$/ });
    expect(transform(unlifter, lifted, "/app/src/price.ts").result).not.toBeNull();
    expect(transform(unlifter, lifted, "/app/lib/price.ts").result).toBeNull();
    expect(transform(unlifter, lifted, "/app/src/price.test.ts").result).toBeNull();
  });

  it("warns about each binding that stays lifted, and why", () => {
    const shared = `${lifted}export const test = () => priceHermetic.call({ RATE: 1 }, 1);\n`;
    const { result, warnings } = transform(unliftPlugin(), shared, "/app/src/price.ts");
    expect(result).toBeNull();
    expect(warnings).toEqual([
      "'price' on line 2 stays lifted: the core is used elsewhere.",
      "'test' on line 8 stays lifted: the core is used elsewhere.",
    ]);
  });

  it("is a Vite plugin, and a Rolldown one", () => {
    const vite: Plugin[] = [unliftPlugin()];
    const rolldown: Rolldown.Plugin[] = [unliftPlugin()];
    expect(vite[0]).toMatchObject({ name: "hermetic-unlift", enforce: "pre", apply: "build" });
    expect(rolldown).toHaveLength(1);
  });
});

describe("a production build of lifted source", () => {
  const modules: Record<string, string> = {
    "index.ts": [
      `export { check } from "./limits.ts";`,
      `export { discount, round, total } from "./pricing.ts";`,
      `export { next, reset } from "./counter.ts";`,
    ].join("\n"),
    "limits.ts": [
      `const LIMIT = 100;`,
      ``,
      `/** Throws past the limit. */`,
      `export const check = (n: number) => {`,
      `  if (n > LIMIT) {`,
      `    throw new RangeError("over the limit");`,
      `  }`,
      `  return n;`,
      `};`,
    ].join("\n"),
    "pricing.ts": [
      `import { check } from "./limits.ts";`,
      ``,
      `const RATE = 0.2;`,
      ``,
      `export const round = (n: number) => Math.round(n * 100) / 100;`,
      ``,
      `export const discount = (price: number) => round(check(price) * (1 - RATE));`,
      ``,
      `export function total(prices: readonly number[]): number {`,
      `  return prices.reduce(add, 0);`,
      `}`,
      ``,
      `function add(sum: number, price: number): number {`,
      `  return sum + price;`,
      `}`,
    ].join("\n"),
    "counter.ts": [
      `let count = 0;`,
      ``,
      `export const next = (step = 1) => {`,
      `  count += step;`,
      `  return count;`,
      `};`,
      ``,
      `export const reset = () => {`,
      `  count = 0;`,
      `};`,
    ].join("\n"),
  };

  // Both trees are built from the same directory, which the bundle's comments name.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-unlift-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Writes the modules, marked or lifted, and bundles them for production. */
  const bundle = async (lift: boolean, plugins: Plugin[], sourcemap = false): Promise<Rolldown.OutputChunk> => {
    for (const [file, code] of Object.entries(modules)) fs.writeFileSync(path.join(root, file), fix(code, file, lift));
    const output = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins,
      build: { write: false, minify: true, sourcemap, lib: { entry: path.join(root, "index.ts"), formats: ["es"], fileName: "index" } },
    });
    const [result] = Array.isArray(output) ? output : [output];
    const chunk = result && "output" in result ? result.output[0] : undefined;
    if (!chunk) throw new Error("the build produced no chunk");
    return chunk;
  };

  it("is the build of the original, byte for byte", async () => {
    const expected = await bundle(false, []);
    const unchanged = await bundle(true, []);
    const lifted = Object.keys(modules).map((file) => fs.readFileSync(path.join(root, file), "utf8"));
    expect(lifted.join("\n").match(/\.call\(/g)?.length, "the lift should rewrite each exported function").toBe(6);
    expect(unchanged.code).not.toBe(expected.code);

    const unlifted = await bundle(true, [unliftPlugin()]);
    expect(unlifted.code).toBe(expected.code);
  });

  it("maps its code back to the lifted source", async () => {
    const chunk = await bundle(true, [unliftPlugin()], true);
    if (!chunk.map) throw new Error("no source map");
    const map = new TraceMap({ ...chunk.map, version: 3 });
    const mapped = originalPositionFor(map, find(chunk.code, `"over the limit"`));
    const limits = fs.readFileSync(path.join(root, "limits.ts"), "utf8");
    expect(mapped.source?.endsWith("limits.ts")).toBe(true);
    expect({ line: mapped.line, column: mapped.column }).toEqual(find(limits, `"over the limit"`));
  });
});
