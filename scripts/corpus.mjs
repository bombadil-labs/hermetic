#!/usr/bin/env node
// Measures the rules against real code: TypeScript sources shipped by large
// open-source packages, pinned below and downloaded into .corpus/.
//
//   npm run corpus            census, stress and fix
//   npm run corpus -- census  which functions are hermetic, liftable, or need a person
//   npm run corpus -- stress  every function analyzed as if marked; nothing may throw
//   npm run corpus -- fix        `prefer-hermetic --fix` with lift: parses, sealed, settled, no new type errors
//   npm run corpus -- roundtrip  unlifting the lifted corpus gives back the marked corpus
//   npm run corpus -- effect     lifts Effect's own source and runs its test suite (needs git and pnpm);
//                                with --unlift, lifts and then unlifts it first
//   npm run corpus -- bench      times Effect workloads on its original, lifted and unlifted source
//
// Library code is one particular shape: few globals, many small helpers, heavy
// use of namespace imports. Application code reaches for more ambient
// authority (fetch, Date, process) and has more classes and components, so
// expect it to split differently.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import ts from "typescript";
import { analyze, createEnvironment } from "../src/analysis.ts";
import plugin from "../src/index.ts";
import { planLift } from "../src/lift.ts";
import { unlift } from "../src/unlift.ts";
import { functionName, isMarkedHermetic } from "../src/marking.ts";
import { isCandidate } from "../src/rules/prefer-hermetic.ts";
import { sealed } from "../src/rules/sealed.ts";

const PACKAGES = {
  effect: "3.22.2",
  rxjs: "7.8.2",
  "@tanstack/query-core": "5.103.2",
  "@tanstack/react-query": "5.103.2",
  "@types/react": "19.3.0",
};
const SOURCES = ["effect/src", "rxjs/src", "@tanstack/query-core/src", "@tanstack/react-query/src"];
const EFFECT = { repository: "https://github.com/Effect-TS/effect", tag: `effect@${PACKAGES.effect}` };

const root = fileURLToPath(new URL("../.corpus/", import.meta.url));
const original = path.join(root, "original");
const fixedDir = path.join(root, "fixed");
const roundtripDir = path.join(root, "roundtrip");

function prepare() {
  const installed = Object.entries(PACKAGES).every(([name, version]) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version === version;
    } catch {
      return false;
    }
  });
  if (!installed) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{ "private": true }\n');
    console.log("Downloading the corpus...");
    const specs = Object.entries(PACKAGES).map(([name, version]) => `${name}@${version}`);
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...specs], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }
  // ESLint ignores node_modules, so lint copies.
  fs.rmSync(original, { recursive: true, force: true });
  for (const source of SOURCES) {
    fs.cpSync(path.join(root, "node_modules", source), path.join(original, source), { recursive: true });
  }
}

function sourceFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((file) => path.join(dir, String(file)))
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"));
}

function config(rules, extraPlugins = {}) {
  return [
    {
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { hermetic: plugin, ...extraPlugins },
      linterOptions: { reportUnusedDisableDirectives: "off" },
      rules,
    },
  ];
}

function lint(dir, rules, extraPlugins) {
  const linter = new Linter({ cwd: dir });
  return sourceFiles(dir).map((file) => ({
    file,
    messages: linter.verify(fs.readFileSync(file, "utf8"), config(rules, extraPlugins), { filename: file }),
  }));
}

/** Reports every unmarked candidate, so the census can count what prefer-hermetic leaves for a person. */
const census = {
  rules: {
    candidates: {
      meta: { schema: [], messages: { candidate: "candidate" } },
      create: (context) => ({
        ":function"(node) {
          if (isCandidate(node) && !isMarkedHermetic(node, context.sourceCode)) context.report({ node, messageId: "candidate" });
        },
      }),
    },
  },
};

function runCensus() {
  const results = lint(original, { "corpus/candidates": "error", "hermetic/prefer-hermetic": ["error", { lift: true }] }, { corpus: census });
  const count = (id) => results.reduce((sum, { messages }) => sum + messages.filter((m) => m.messageId === id).length, 0);
  const candidates = count("candidate");
  const already = count("alreadyHermetic");
  const liftable = count("liftable");
  const row = (label, n) => console.log(`  ${String(n).padStart(6)}  ${((100 * n) / candidates).toFixed(1).padStart(5)}%  ${label}`);
  console.log(`\nCensus: ${candidates} candidate functions in ${results.length} files`);
  row("already hermetic: --fix marks them", already);
  row("liftable: --fix with lift splits them", liftable);
  row("left for a person: this, JSX, hoisted declarations that read imports...", candidates - already - liftable);
}

/** Analyzes every function as if marked, under three configurations. Nothing may throw. */
function runStress() {
  const configurations = {
    default: {},
    strict: { types: "structural-only", aliasing: "forbid" },
    bootstrap: { ground: fileURLToPath(new URL("../tests/fixtures/grounds/clock.ground.ts", import.meta.url)), aliasing: "forbid" },
  };
  for (const [label, options] of Object.entries(configurations)) {
    const crashes = [];
    const stress = {
      rules: {
        everything: {
          meta: { schema: [], messages: { problem: "problem" } },
          create(context) {
            const env = createEnvironment(context, options, sealed);
            return {
              ":function"(node) {
                try {
                  const problems = analyze(node, functionName(node), env);
                  planLift(node, problems, env);
                } catch (error) {
                  crashes.push(`${path.relative(original, context.filename)}:${node.loc.start.line} ${error.message}`);
                }
              },
            };
          },
        },
      },
    };
    const started = performance.now();
    lint(original, { "stress/everything": "error" }, { stress });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`Stress (${label}): ${crashes.length} crashes in ${seconds}s`);
    for (const crash of crashes.slice(0, 10)) console.log(`  ${crash}`);
  }
}

function typeErrors(dir) {
  const program = ts.createProgram(sourceFiles(dir), {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: ["node"],
  });
  const counts = new Map();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (!diagnostic.file?.fileName.startsWith(dir.split(path.sep).join("/"))) continue;
    const key = `${path.relative(dir, diagnostic.file.fileName)} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** A function that applies the fixes of `rules` to one file's code. */
function fixer(rules, cwd) {
  const linter = new Linter({ cwd });
  return (code, file) => linter.verifyAndFix(code, config(rules), { filename: file }).output;
}

/** Type errors in `dir` that `original` does not have, as "count x file TScode: message" lines. */
function introducedTypeErrors(dir) {
  const before = typeErrors(original);
  const after = typeErrors(dir);
  const introduced = [];
  for (const [key, n] of after) {
    const extra = n - (before.get(key) ?? 0);
    if (extra > 0) introduced.push(`${extra} x ${key}`);
  }
  return { before, after, introduced };
}

/** Applies `prefer-hermetic --fix` with lift to every source file under `dir`, in place. */
function fixInPlace(dir) {
  const rules = { "hermetic/prefer-hermetic": ["error", { lift: true }], "hermetic/sealed": "error" };
  const linter = new Linter({ cwd: dir });
  const counts = { changed: 0, unparsable: 0, unsealed: 0, unsettled: 0 };
  for (const file of sourceFiles(dir)) {
    const code = fs.readFileSync(file, "utf8");
    const first = linter.verifyAndFix(code, config(rules), { filename: file });
    if (first.output !== code) counts.changed++;
    fs.writeFileSync(file, first.output);
    counts.unparsable += first.messages.filter((m) => m.fatal).length;
    counts.unsealed += first.messages.filter((m) => m.ruleId === "hermetic/sealed").length;
    const second = linter.verifyAndFix(first.output, config(rules), { filename: file });
    if (second.output !== first.output) counts.unsettled++;
  }
  return counts;
}

function runFix() {
  fs.rmSync(fixedDir, { recursive: true, force: true });
  fs.cpSync(original, fixedDir, { recursive: true });
  const started = performance.now();
  const { changed, unparsable, unsealed, unsettled } = fixInPlace(fixedDir);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\nFix: ${changed} files changed in ${seconds}s`);
  console.log(`  ${unparsable} parse errors, ${unsealed} sealed errors, ${unsettled} files a second pass would change`);

  console.log("Type checking the original and fixed trees...");
  const { before, after, introduced } = introducedTypeErrors(fixedDir);
  console.log(`  ${[...before.values()].reduce((a, b) => a + b, 0)} type errors before, ${[...after.values()].reduce((a, b) => a + b, 0)} after, ${introduced.length} kinds introduced`);
  for (const line of introduced.slice(0, 20)) console.log(`  ${line.slice(0, 220)}`);
}

/**
 * Unlifting the lifted corpus must give back the marked corpus: the same
 * program, comments included, up to what the lift cannot record. Compared on
 * the syntax tree with types erased, so formatting and the lift's type
 * annotations do not count, and with three equivalences allowed:
 *
 * - `(x) => { return y; }` and `(x) => y`, which lift to the same core
 * - `{ x: x }` and `{ x }`, which lift to the same `{ x: this.x }`
 * - redundant parentheses, which the syntax tree does not keep
 */
function runRoundtrip() {
  fs.rmSync(roundtripDir, { recursive: true, force: true });
  fs.cpSync(original, roundtripDir, { recursive: true });
  const mark = fixer({ "hermetic/prefer-hermetic": "error" }, roundtripDir);
  const lift = fixer({ "hermetic/prefer-hermetic": ["error", { lift: true }] }, roundtripDir);
  let files = 0;
  let cores = 0;
  let folded = 0;
  const skipped = [];
  const mismatches = [];
  const started = performance.now();
  for (const file of sourceFiles(roundtripDir)) {
    const code = fs.readFileSync(file, "utf8");
    const lifted = lift(code, file);
    const marked = mark(code, file);
    if (lifted === marked) continue;
    files++;
    // Each core carries one directive; marking alone adds the rest.
    cores += directives(lifted) - directives(marked);
    const result = unlift(lifted, file);
    folded += result.unlifted.length;
    for (const skip of result.skipped) skipped.push(`${path.relative(roundtripDir, file)}:${skip.line} ${skip.name}: ${skip.reason}`);
    fs.writeFileSync(file, result.code);
    const difference = compareModules(result.code, marked, file);
    if (difference) mismatches.push(`${path.relative(roundtripDir, file)}: ${difference}`);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\nRound trip: ${files} files with lifts, ${cores} cores, ${folded} folded back in ${seconds}s`);
  console.log(`  ${skipped.length} bindings skipped, ${mismatches.length} files that differ from the marked original`);
  for (const line of [...skipped, ...mismatches].slice(0, 20)) console.log(`  ${line.slice(0, 400)}`);
  console.log("Type checking the round-tripped tree...");
  const { introduced } = introducedTypeErrors(roundtripDir);
  console.log(`  ${introduced.length} kinds of type errors introduced`);
  for (const line of introduced.slice(0, 10)) console.log(`  ${line.slice(0, 220)}`);
}

function directives(code) {
  return code.split('"use hermetic"').length - 1;
}

/** Why two modules are not the same program, or undefined when they are. */
function compareModules(actual, expected, file) {
  const read = (code) => {
    const { ast } = tsParser.parseForESLint(code, { filePath: file, range: true, loc: true, ecmaFeatures: { jsx: file.endsWith("x") } });
    return { statements: ast.body, comments: ast.comments.map((comment) => `${comment.type}:${comment.value}`), code };
  };
  const a = read(actual);
  const b = read(expected);
  const count = Math.max(a.statements.length, b.statements.length);
  for (let i = 0; i < count; i++) {
    const [x, y] = [a.statements[i], b.statements[i]];
    if (JSON.stringify(normalizeNode(x)) !== JSON.stringify(normalizeNode(y))) {
      const excerpt = (node, code) => (node ? code.slice(node.range[0], node.range[1]).replace(/\s+/g, " ").slice(0, 150) : "(nothing)");
      return `statement ${i + 1} is\n      ${excerpt(x, a.code)}\n    but should be\n      ${excerpt(y, b.code)}`;
    }
  }
  const comment = a.comments.findIndex((value, i) => value !== b.comments[i]);
  if (comment !== -1 || a.comments.length !== b.comments.length) {
    const i = comment === -1 ? Math.min(a.comments.length, b.comments.length) : comment;
    return `comment ${i + 1} is ${JSON.stringify(a.comments[i])} but should be ${JSON.stringify(b.comments[i])}`;
  }
  return undefined;
}

const IGNORED_KEYS = new Set(["range", "loc", "parent", "typeAnnotation", "returnType", "typeParameters", "typeArguments"]);

function normalizeNode(node) {
  if (Array.isArray(node)) return node.map(normalizeNode);
  if (typeof node === "bigint") return `${node}n`;
  if (!node || typeof node !== "object") return node;
  let current = node;
  if (current.type === "ArrowFunctionExpression" && current.body.type === "BlockStatement") {
    const [only, ...rest] = current.body.body;
    if (rest.length === 0 && only?.type === "ReturnStatement" && only.argument) current = { ...current, body: only.argument, expression: true };
  }
  const result = {};
  for (const [key, value] of Object.entries(current)) if (!IGNORED_KEYS.has(key)) result[key] = normalizeNode(value);
  if (result.type === "Property" && !result.computed && !result.method && result.kind === "init" && result.key.type === "Identifier") {
    const value = result.value.type === "AssignmentPattern" ? result.value.left : result.value;
    if (value.type === "Identifier" && value.name === result.key.name) result.shorthand = true;
  }
  return result;
}

/**
 * Behavior, not just types: lifts the source in a checkout of Effect's
 * repository at the pinned release and runs Effect's own test suite on it.
 */
function effectCheckout() {
  const checkout = path.join(root, "effect-repository");
  if (!fs.existsSync(path.join(checkout, "pnpm-lock.yaml"))) {
    console.log(`Cloning ${EFFECT.repository} at ${EFFECT.tag}...`);
    fs.rmSync(checkout, { recursive: true, force: true });
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", EFFECT.tag, EFFECT.repository, checkout], { stdio: "inherit" });
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", ".", "--filter", "effect", "--filter", "@effect/vitest"], {
      cwd: checkout,
      stdio: "inherit",
      shell,
    });
  }
  execFileSync("git", ["checkout", "--quiet", "--", "packages/effect/src"], { cwd: checkout });
  return checkout;
}

const shell = process.platform === "win32";

/** Unlifts every source file under `dir` in place, and reports what it folded back and skipped. */
function unliftInPlace(dir) {
  let folded = 0;
  const skipped = [];
  for (const file of sourceFiles(dir)) {
    const result = unlift(fs.readFileSync(file, "utf8"), file);
    folded += result.unlifted.length;
    for (const skip of result.skipped) skipped.push(`${path.relative(dir, file)}:${skip.line} ${skip.name}: ${skip.reason}`);
    fs.writeFileSync(file, result.code);
  }
  return { folded, skipped };
}

function runEffect(options) {
  const checkout = effectCheckout();
  const src = path.join(checkout, "packages/effect/src");
  const { changed, unparsable, unsealed, unsettled } = fixInPlace(src);
  const lifted = sourceFiles(src)
    .map((file) => unlift(fs.readFileSync(file, "utf8"), file).unlifted.length)
    .reduce((a, b) => a + b, 0);
  console.log(`\nEffect: ${changed} files changed, ${lifted} functions lifted`);
  console.log(`  ${unparsable} parse errors, ${unsealed} sealed errors, ${unsettled} files a second pass would change`);
  if (options.unlift) {
    const { folded, skipped } = unliftInPlace(src);
    console.log(`  ${folded} folded back by unlift, ${skipped.length} skipped`);
    for (const line of skipped.slice(0, 10)) console.log(`  ${line}`);
  }
  console.log(`Running Effect's test suite on the ${options.unlift ? "unlifted" : "lifted"} source...`);
  execFileSync(path.join(checkout, "node_modules", ".bin", shell ? "vitest.cmd" : "vitest"), ["run", "--reporter=dot"], {
    cwd: path.join(checkout, "packages/effect"),
    stdio: "inherit",
    shell,
  });
}

const BENCHMARK = `// Written by scripts/corpus.mjs. Times hot Effect workloads on one copy of the source.
const tree = process.argv[2]
const { Effect, Chunk, HashMap, Option, Array: Arr, pipe, Schema } = await import(\`./\${tree}/index.ts\`)

const workloads: Record<string, () => unknown> = {
  "Effect.gen, map, flatMap": () =>
    Effect.runSync(Effect.gen(function*() {
      let sum = 0
      for (let i = 0; i < 200; i++) {
        sum += yield* Effect.succeed(i).pipe(Effect.map((x: number) => x + 1), Effect.flatMap((x: number) => Effect.succeed(x * 2)))
      }
      return sum
    })),
  "Chunk, HashMap, Option": () => {
    let map = HashMap.empty<number, number>()
    for (let i = 0; i < 200; i++) map = HashMap.set(map, i, i * 2)
    const chunk = Chunk.map(Chunk.range(0, 199), (i: number) => Option.getOrElse(HashMap.get(map, i), () => 0))
    return pipe(Arr.fromIterable(chunk), Arr.filter((x: number) => x % 3 === 0), Arr.reduce(0, (a: number, b: number) => a + b))
  },
  "Schema decode": (() => {
    const Person = Schema.Struct({ name: Schema.String, age: Schema.Number, tags: Schema.Array(Schema.String) })
    const decode = Schema.decodeUnknownSync(Person)
    return () => { for (let i = 0; i < 50; i++) decode({ name: "a", age: i, tags: ["x", "y"] }) }
  })(),
}

const medians: Record<string, number> = {}
for (const [name, run] of Object.entries(workloads)) {
  for (let i = 0; i < 300; i++) run()
  const samples: number[] = []
  for (let round = 0; round < 7; round++) {
    const start = performance.now()
    for (let i = 0; i < 500; i++) run()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  medians[name] = samples[3]
}
console.log(JSON.stringify(medians))
`;

/**
 * What the lift costs, and what unlifting gives back: hot Effect workloads
 * timed on three copies of Effect's source, each in fresh processes. Each
 * figure is the best median across the processes.
 */
function runBench() {
  const checkout = effectCheckout();
  const packageDir = path.join(checkout, "packages/effect");
  const benchDir = path.join(packageDir, ".hermetic-bench");
  fs.rmSync(benchDir, { recursive: true, force: true });
  const trees = ["original", "lifted", "unlifted"];
  for (const tree of trees) fs.cpSync(path.join(packageDir, "src"), path.join(benchDir, tree), { recursive: true });
  fixInPlace(path.join(benchDir, "lifted"));
  fixInPlace(path.join(benchDir, "unlifted"));
  const { folded, skipped } = unliftInPlace(path.join(benchDir, "unlifted"));
  console.log(`\nBenchmark: ${folded} bindings folded back in the unlifted copy, ${skipped.length} skipped`);
  fs.writeFileSync(path.join(benchDir, "run.ts"), BENCHMARK);
  const best = {};
  for (let round = 0; round < 2; round++) {
    for (const tree of trees) {
      const output = execFileSync(process.execPath, ["--import", "tsx", path.join(benchDir, "run.ts"), tree], { cwd: packageDir, encoding: "utf8" });
      for (const [workload, ms] of Object.entries(JSON.parse(output.trim().split("\n").at(-1)))) {
        best[workload] ??= {};
        best[workload][tree] = Math.min(best[workload][tree] ?? Infinity, ms);
      }
    }
  }
  console.log(`  ${"workload".padEnd(26)}${trees.map((tree) => tree.padStart(18)).join("")}`);
  for (const [workload, times] of Object.entries(best)) {
    const cells = trees.map((tree) => {
      const change = tree === "original" ? "" : ` (${times[tree] >= times.original ? "+" : ""}${Math.round((100 * (times[tree] - times.original)) / times.original)}%)`;
      return `${times[tree].toFixed(1)}ms${change}`.padStart(18);
    });
    console.log(`  ${workload.padEnd(26)}${cells.join("")}`);
  }
}

const command = process.argv[2] ?? "all";
prepare();
if (command === "census" || command === "all") runCensus();
if (command === "stress" || command === "all") runStress();
if (command === "fix" || command === "all") runFix();
if (command === "roundtrip" || command === "all") runRoundtrip();
if (command === "effect") runEffect({ unlift: process.argv.includes("--unlift") });
if (command === "bench") runBench();
