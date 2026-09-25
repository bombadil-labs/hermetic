#!/usr/bin/env node
// Measures the rules against real code: TypeScript sources shipped by large
// open-source packages, pinned below and downloaded into .corpus/.
//
//   npm run corpus               census, stress, fix and roundtrip
//   npm run corpus -- census     which functions are hermetic, liftable, or need a person
//   npm run corpus -- stress     every function analyzed as if marked; nothing may throw
//   npm run corpus -- fix        `prefer-hermetic --fix` with lift: parses, sealed, settled, no new type errors
//   npm run corpus -- roundtrip  unlifting the lifted corpus gives back the marked corpus
//   npm run corpus -- crosscheck every function in the published JavaScript, checked by sealed and by
//                                check() from its source text alone; the two must find the same problems
//   npm run corpus -- effect     lifts Effect's own source and runs its test suite (needs git and pnpm);
//                                with --unlift, lifts and then unlifts it first
//   npm run corpus -- bench      times Effect workloads on its original, lifted and unlifted source,
//                                and on a second copy of the original that shows the noise
//   npm run corpus -- records    writes what happened to every candidate function to .corpus/results/records.json
//   npm run corpus -- report     writes site/data/corpus.json for the case studies, from all of the above;
//                                commit first: every result records the commit it came from
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
import { analyze, createEnvironment, isAmbient } from "../packages/eslint-plugin-hermetic/src/analysis.ts";
import plugin from "../packages/eslint-plugin-hermetic/src/index.ts";
import { planLift, tryLift } from "../packages/eslint-plugin-hermetic/src/lift.ts";
import { unlift } from "../packages/eslint-plugin-hermetic/src/unlift.ts";
import { functionName, isFunctionNode, isMarkedHermetic, isMethod } from "../packages/eslint-plugin-hermetic/src/marking.ts";
import { isCandidate } from "../packages/eslint-plugin-hermetic/src/rules/prefer-hermetic.ts";
import { check } from "@bombadil/hermetic";

const PACKAGES = {
  effect: "3.22.2",
  rxjs: "7.8.2",
  "@tanstack/query-core": "5.103.2",
  "@tanstack/react-query": "5.103.2",
  "@types/react": "19.3.0",
};
const SOURCES = ["effect/src", "rxjs/src", "@tanstack/query-core/src", "@tanstack/react-query/src"];
/** The ES module builds the packages publish, compiled from those sources. */
const PUBLISHED = ["effect/dist/esm", "rxjs/dist/esm", "rxjs/dist/esm5", "@tanstack/query-core/build/modern", "@tanstack/react-query/build/modern"];
const EFFECT = { repository: "https://github.com/Effect-TS/effect", tag: `effect@${PACKAGES.effect}` };

const root = fileURLToPath(new URL("../.corpus/", import.meta.url));
const original = path.join(root, "original");
const fixedDir = path.join(root, "fixed");
const roundtripDir = path.join(root, "roundtrip");
const resultsDir = path.join(root, "results");
const siteData = fileURLToPath(new URL("../site/data/corpus.json", import.meta.url));

/**
 * The commit a result comes from, and whether the code that decides the
 * numbers had uncommitted changes when it ran.
 */
function provenance() {
  const git = (...args) => execFileSync("git", args, { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" }).trim();
  const dirty = git("status", "--porcelain", "--", "packages/*/src", "packages/*/package.json", "scripts/corpus.mjs", "package.json", "package-lock.json") !== "";
  return { commit: git("rev-parse", "--short", "HEAD"), dirty };
}

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

/** Analyzes every function as if marked, under both settings of `types`. Nothing may throw. */
function runStress() {
  const configurations = {
    default: {},
    strict: { types: "structural-only" },
  };
  for (const [label, options] of Object.entries(configurations)) {
    const crashes = [];
    const stress = {
      rules: {
        everything: {
          meta: { schema: [], messages: { problem: "problem" } },
          create(context) {
            const env = createEnvironment(context, options);
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

/** What sealed calls each construct it reports, as check() names it. */
const CONSTRUCTS = { lexicalThis: "this", superReference: "super", lexicalNewTarget: "new.target", importMeta: "import.meta", dynamicImport: "import()" };

/**
 * Checks every function in the published JavaScript twice: with sealed, as if
 * it were marked, and with check() on the text Function.prototype.toString
 * gives for it. Both must report the same problems at the same places, except
 * where sealed sees the module around the function and check() by design
 * cannot: a function declaration whose own name the module reassigns. Neither
 * can mark a method or a class, so check() must refuse every one.
 */
function runCrosscheck() {
  const tally = { files: 0, functions: 0, methods: 0, constructors: 0, hermetic: 0, same: 0, agreed: {}, classes: 0 };
  const moduleOnly = [];
  const differing = [];
  const oracle = {
    rules: {
      compare: {
        meta: { schema: [], messages: { x: "x" } },
        create(context) {
          const env = createEnvironment(context, {});
          const text = context.sourceCode.text;
          const file = path.relative(path.join(root, "published"), context.filename).split(path.sep).join("/");
          return {
            // A class can't be hermetic yet, and check() must read every one as a class and refuse it.
            "ClassDeclaration, ClassExpression"(node) {
              tally.classes++;
              const result = check(text.slice(node.range[0], node.range[1]));
              if (result.form !== "class" || result.problems.length !== 1 || result.problems[0].kind !== "method") {
                differing.push({ file, line: node.loc.start.line, name: node.id?.name, class: true, problems: result.problems });
              }
            },
            ":function"(node) {
              const parent = node.parent;
              const method = parent.type === "MethodDefinition" || (parent.type === "Property" && (parent.method || parent.kind !== "init"));
              // A class constructor is the class: its source is the whole class.
              if (parent.type === "MethodDefinition" && parent.kind === "constructor") return void tally.constructors++;
              tally.functions++;
              if (method) tally.methods++;
              let [start, end] = method ? parent.range : node.range;
              // A static method's source starts after `static`.
              if (parent.type === "MethodDefinition" && parent.static) start += /^static\b\s*/.exec(text.slice(start, end))[0].length;
              const source = text.slice(start, end);
              // Neither can mark a method: sealed reports a marked one, and check() refuses its source.
              if (method) {
                const refused = check(source).problems;
                if (refused.length === 1 && refused[0].kind === "method") return void (tally.agreed.method = (tally.agreed.method ?? 0) + 1);
                return void differing.push({ file, line: node.loc.start.line, name: functionName(node), checkOnly: refused.map((p) => `${p.kind}:${p.name}`), source });
              }
              const at = (node, from = start) => `@${node.range[0] - from}-${node.range[1] - from}`;
              const expected = analyze(node, functionName(node), env).map((problem) => ({
                kind: problem.messageId,
                key: `${problem.messageId}:${problem.data.name ?? problem.data.path ?? CONSTRUCTS[problem.messageId]}${at(problem.node)}`,
                reference: problem.reference,
              }));
              const actual = check(source).problems.map((problem) => `${problem.kind}:${problem.name}@${problem.start}-${problem.end}`);
              const missing = [...actual];
              const extra = [];
              for (const { key } of expected) {
                const index = missing.indexOf(key);
                if (index === -1) extra.push(key);
                else missing.splice(index, 1);
              }
              if (extra.length === 0 && missing.length === 0) {
                if (expected.length === 0) tally.hermetic++;
                else tally.same++;
                for (const { kind } of expected) tally.agreed[kind] = (tally.agreed[kind] ?? 0) + 1;
                return;
              }
              const record = { file, line: node.loc.start.line, name: functionName(node), sealedOnly: extra, checkOnly: missing, source: source.length > 400 ? `${source.slice(0, 400)}...` : source };
              // A problem only the module can show: a declaration's own name read as a free variable, because the module reassigns it.
              const seesModule = (problem) =>
                problem.kind === "freeVariable" && node.type === "FunctionDeclaration" && problem.reference.resolved?.defs.some((def) => def.node === node);
              const explained = new Set(expected.filter(seesModule).map((problem) => problem.key));
              if (missing.length === 0 && extra.every((key) => explained.has(key))) moduleOnly.push(record);
              else differing.push(record);
            },
          };
        },
      },
    },
  };
  const linter = new Linter({ cwd: root });
  const rules = { "oracle/compare": "error" };
  const started = performance.now();
  for (const dir of PUBLISHED) {
    const base = path.join(root, "node_modules", dir);
    for (const entry of fs.readdirSync(base, { recursive: true })) {
      if (!String(entry).endsWith(".js")) continue;
      tally.files++;
      // Linting node_modules is off, so each file is linted under a name outside it.
      const filename = path.join(root, "published", dir, String(entry));
      const config = [{ files: ["**/*.js"], languageOptions: { parser: tsParser }, plugins: { oracle }, linterOptions: { reportUnusedDisableDirectives: "off" }, rules }];
      const messages = linter.verify(fs.readFileSync(path.join(base, String(entry)), "utf8"), config, { filename });
      for (const message of messages.filter((m) => m.fatal)) differing.push({ file: path.relative(root, filename), line: message.line, fatal: message.message });
    }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const row = (label, n) => console.log(`  ${String(n).padStart(6)}  ${label}`);
  console.log(`\nCrosscheck: ${tally.functions} functions, ${tally.methods} of them methods, in ${tally.files} files of published JavaScript, in ${seconds}s`);
  row("hermetic, by both", tally.hermetic);
  row("the same problems at the same places", tally.same);
  row("differ only where sealed sees the module: a declaration whose own name the module reassigns", moduleOnly.length);
  row("differ otherwise", differing.length);
  console.log(`  (and ${tally.constructors} class constructors, whose source is their whole class)`);
  console.log(`  Classes, each refused as a class unless listed below: ${tally.classes}`);
  console.log(`  Problems both found: ${Object.entries(tally.agreed).sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${kind}`).join(", ")}`);
  for (const record of differing.slice(0, 10)) console.log(`\n  ${record.file}:${record.line} ${record.name ?? ""}\n    sealed only: ${record.sealedOnly?.join(", ") || "-"}\n    check only:  ${record.checkOnly?.join(", ") || record.fatal || "-"}`);
  fs.mkdirSync(resultsDir, { recursive: true });
  const result = { date: new Date().toISOString(), ...provenance(), node: process.version, packages: PACKAGES, published: PUBLISHED, ...tally, moduleOnly, differing };
  fs.writeFileSync(path.join(resultsDir, "crosscheck.json"), `${JSON.stringify(result, null, 1)}\n`);
  return result;
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
  const counts = { changed: 0, unparsable: 0, unsealed: 0, unsettled: 0, files: [] };
  for (const file of sourceFiles(dir)) {
    const code = fs.readFileSync(file, "utf8");
    const first = linter.verifyAndFix(code, config(rules), { filename: file });
    fs.writeFileSync(file, first.output);
    const second = linter.verifyAndFix(first.output, config(rules), { filename: file });
    const result = {
      file: path.relative(dir, file),
      changed: first.output !== code,
      unparsable: first.messages.filter((m) => m.fatal).length,
      unsealed: first.messages.filter((m) => m.ruleId === "hermetic/sealed").length,
      unsettled: second.output !== first.output,
    };
    counts.files.push(result);
    if (result.changed) counts.changed++;
    counts.unparsable += result.unparsable;
    counts.unsealed += result.unsealed;
    if (result.unsettled) counts.unsettled++;
  }
  return counts;
}

function runFix() {
  fs.rmSync(fixedDir, { recursive: true, force: true });
  fs.cpSync(original, fixedDir, { recursive: true });
  const started = performance.now();
  const fixed = fixInPlace(fixedDir);
  const { changed, unparsable, unsealed, unsettled } = fixed;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\nFix: ${changed} files changed in ${seconds}s`);
  console.log(`  ${unparsable} parse errors, ${unsealed} sealed errors, ${unsettled} files a second pass would change`);

  console.log("Type checking the original and fixed trees...");
  const { before, after, introduced } = introducedTypeErrors(fixedDir);
  console.log(`  ${[...before.values()].reduce((a, b) => a + b, 0)} type errors before, ${[...after.values()].reduce((a, b) => a + b, 0)} after, ${introduced.length} kinds introduced`);
  for (const line of introduced.slice(0, 20)) console.log(`  ${line.slice(0, 220)}`);
  return { files: fixed.files, introduced };
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
  const perFile = [];
  const started = performance.now();
  for (const file of sourceFiles(roundtripDir)) {
    const code = fs.readFileSync(file, "utf8");
    const lifted = lift(code, file);
    const marked = mark(code, file);
    if (lifted === marked) continue;
    files++;
    // Each core carries one directive; marking alone adds the rest.
    const fileCores = directives(lifted) - directives(marked);
    cores += fileCores;
    const result = unlift(lifted, file);
    folded += result.unlifted.length;
    for (const skip of result.skipped) skipped.push(`${path.relative(roundtripDir, file)}:${skip.line} ${skip.name}: ${skip.reason}`);
    fs.writeFileSync(file, result.code);
    const difference = compareModules(result.code, marked, file);
    if (difference) mismatches.push(`${path.relative(roundtripDir, file)}: ${difference}`);
    perFile.push({ file: path.relative(roundtripDir, file), cores: fileCores, folded: result.unlifted.length, skipped: result.skipped.length, differs: Boolean(difference) });
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\nRound trip: ${files} files with lifts, ${cores} cores, ${folded} folded back in ${seconds}s`);
  console.log(`  ${skipped.length} bindings skipped, ${mismatches.length} files that differ from the marked original`);
  for (const line of [...skipped, ...mismatches].slice(0, 20)) console.log(`  ${line.slice(0, 400)}`);
  console.log("Type checking the round-tripped tree...");
  const { introduced } = introducedTypeErrors(roundtripDir);
  console.log(`  ${introduced.length} kinds of type errors introduced`);
  for (const line of introduced.slice(0, 10)) console.log(`  ${line.slice(0, 220)}`);
  return { files: perFile, introduced };
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
  fs.mkdirSync(resultsDir, { recursive: true });
  const output = path.join(resultsDir, `effect-${options.unlift ? "unlifted" : "lifted"}.vitest.json`);
  execFileSync(
    path.join(checkout, "node_modules", ".bin", shell ? "vitest.cmd" : "vitest"),
    ["run", "--reporter=dot", "--reporter=json", `--outputFile.json=${output}`],
    { cwd: path.join(checkout, "packages/effect"), stdio: "inherit", shell },
  );
  const suite = JSON.parse(fs.readFileSync(output, "utf8"));
  const summary = {
    source: options.unlift ? "unlifted" : "lifted",
    lifted,
    date: new Date().toISOString(),
    ...provenance(),
    files: suite.testResults.length,
    tests: suite.numTotalTests,
    passed: suite.numPassedTests,
    failed: suite.numFailedTests,
    skipped: suite.numPendingTests + suite.numTodoTests,
  };
  fs.writeFileSync(path.join(resultsDir, `effect-${summary.source}.json`), `${JSON.stringify(summary, null, 2)}\n`);
}

/** Timings per workload in each benchmark process; the process keeps the median. */
const BENCH_SAMPLES = 7;

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
  for (let round = 0; round < ${BENCH_SAMPLES}; round++) {
    const start = performance.now()
    for (let i = 0; i < 500; i++) run()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  medians[name] = samples[${BENCH_SAMPLES >> 1}]
}
console.log(JSON.stringify(medians))
`;

/**
 * What the lift costs, and what unlifting gives back: hot Effect workloads
 * timed on copies of Effect's source, each in fresh processes. The control is
 * a second, untouched copy of the original, so how far it lands from the
 * original is the noise. Every copy runs once in each position of the order,
 * and each figure is the best median across its processes.
 */
function runBench() {
  const checkout = effectCheckout();
  const packageDir = path.join(checkout, "packages/effect");
  const benchDir = path.join(packageDir, ".hermetic-bench");
  fs.rmSync(benchDir, { recursive: true, force: true });
  const trees = ["original", "lifted", "unlifted", "control"];
  for (const tree of trees) fs.cpSync(path.join(packageDir, "src"), path.join(benchDir, tree), { recursive: true });
  fixInPlace(path.join(benchDir, "lifted"));
  fixInPlace(path.join(benchDir, "unlifted"));
  const { folded, skipped } = unliftInPlace(path.join(benchDir, "unlifted"));
  console.log(`\nBenchmark: ${folded} bindings folded back in the unlifted copy, ${skipped.length} skipped`);
  fs.writeFileSync(path.join(benchDir, "run.ts"), BENCHMARK);
  const best = {};
  for (let round = 0; round < trees.length; round++) {
    for (const tree of [...trees.slice(round), ...trees.slice(0, round)]) {
      const output = execFileSync(process.execPath, ["--import", "tsx", path.join(benchDir, "run.ts"), tree], { cwd: packageDir, encoding: "utf8" });
      for (const [workload, ms] of Object.entries(JSON.parse(output.trim().split("\n").at(-1)))) {
        best[workload] ??= {};
        best[workload][tree] = Math.min(best[workload][tree] ?? Infinity, ms);
      }
    }
  }
  const result = { date: new Date().toISOString(), ...provenance(), node: process.version, processes: trees.length, samples: BENCH_SAMPLES, workloads: best };
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "bench.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`  ${"workload".padEnd(26)}${trees.map((tree) => tree.padStart(18)).join("")}`);
  for (const [workload, times] of Object.entries(best)) {
    const cells = trees.map((tree) => {
      const change = tree === "original" ? "" : ` (${times[tree] >= times.original ? "+" : ""}${Math.round((100 * (times[tree] - times.original)) / times.original)}%)`;
      return `${times[tree].toFixed(1)}ms${change}`.padStart(18);
    });
    console.log(`  ${workload.padEnd(26)}${cells.join("")}`);
  }
}

/** The libraries the case studies cover, and where their source sits in the corpus. */
const LIBRARIES = [
  { id: "effect", name: "Effect", packages: ["effect"], sources: ["effect/src"] },
  { id: "rxjs", name: "RxJS", packages: ["rxjs"], sources: ["rxjs/src"] },
  {
    id: "tanstack-query",
    name: "TanStack Query",
    packages: ["@tanstack/query-core", "@tanstack/react-query"],
    sources: ["@tanstack/query-core/src", "@tanstack/react-query/src"],
  },
];

/** The functions the case studies show, as they were and as the fix leaves them. */
const EXAMPLES = {
  effect: [
    ["effect/src/Predicate.ts", "isNullable"],
    ["effect/src/Option.ts", "fromNullable"],
    ["effect/src/Array.ts", "tail"],
    ["effect/src/internal/schedule/interval.ts", "after"],
    ["effect/src/Arbitrary.ts", "absurd"],
    ["effect/src/internal/context.ts", "makeGenericTag"],
  ],
  rxjs: [
    ["rxjs/src/internal/util/isFunction.ts", "isFunction"],
    ["rxjs/src/internal/util/pipe.ts", "pipe"],
    ["rxjs/src/internal/operators/map.ts", "map"],
  ],
  "tanstack-query": [
    ["@tanstack/query-core/src/utils.ts", "addToEnd"],
    ["@tanstack/query-core/src/utils.ts", "hashQueryKeyByOptions"],
    ["@tanstack/query-core/src/utils.ts", "timeUntilStale"],
    ["@tanstack/react-query/src/errorBoundaryUtils.ts", "useClearResetErrorBoundary"],
    ["@tanstack/react-query/src/useQuery.ts", "useQuery"],
  ],
};

const libraryOf = (file) => LIBRARIES.find((library) => library.sources.some((source) => file.startsWith(source + "/") || file.startsWith(source + path.sep)));

/**
 * What happens to every candidate function: marked, lifted directly or
 * through a shared context, or skipped and why. A skipped declaration also
 * records the kinds of names it reads, and whether it would lift if imports
 * counted as settled. An outermost function bound to no name, such as a
 * callback passed to another function, is not a candidate; it is recorded as
 * unnamed, with the function it is passed to. Nor is a method, which can't be
 * hermetic yet; an outermost one is recorded as a method.
 */
function censusRecords() {
  const records = [];
  const kindOf = (reference) => {
    const variable = reference.resolved;
    if (!variable || variable.defs.every(isAmbient)) return "global";
    const values = variable.defs.filter((def) => def.type !== "Type");
    if (values.length > 0 && values.every((def) => def.type === "FunctionName")) return "function declaration";
    const def = values[0];
    switch (def?.type) {
      case "ImportBinding":
        return def.node.type === "ImportNamespaceSpecifier" ? "namespace import" : "import";
      case "Variable":
        return def.parent.kind;
      case "ClassName":
        return "class";
      case "TSEnumName":
        return "enum";
      default:
        return "other";
    }
  };
  const plugin = {
    rules: {
      records: {
        meta: { schema: [], messages: { x: "x" } },
        create(context) {
          const env = createEnvironment(context, {});
          const file = path.relative(original, context.filename).split(path.sep).join("/");
          return {
            ":function"(node) {
              if (!isCandidate(node)) {
                for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) if (isFunctionNode(ancestor)) return;
                if (isMethod(node)) return void records.push({ file, name: functionName(node), line: node.loc.start.line, outcome: "method" });
                const callee = node.parent.type === "CallExpression" ? node.parent.callee : undefined;
                const passedTo = callee?.type === "Identifier" ? callee.name : callee?.type === "MemberExpression" && !callee.computed ? callee.property.name : undefined;
                return void records.push({ file, line: node.loc.start.line, outcome: "unnamed", passedTo });
              }
              if (isMarkedHermetic(node, context.sourceCode)) return;
              const problems = analyze(node, functionName(node), env);
              const member = node.parent.type === "Property";
              const record = { file, name: functionName(node), line: node.loc.start.line, member };
              if (problems.length === 0) return void records.push({ ...record, outcome: "hermetic" });
              const result = tryLift(node, problems, env);
              if (typeof result !== "string") {
                return void records.push({ ...record, outcome: result.contextName ? "shared" : "direct" });
              }
              if (result !== "a declaration that reads unsettled names") return void records.push({ ...record, outcome: "skipped", reason: result });
              const kinds = new Map(problems.map((problem) => [problem.reference.identifier.name, kindOf(problem.reference)]));
              const reads = {};
              for (const kind of kinds.values()) reads[kind] = (reads[kind] ?? 0) + 1;
              const onlyImports = typeof tryLift(node, problems, env, { importsSettled: true }) !== "string";
              records.push({ ...record, outcome: "skipped", reason: result, reads, onlyImports });
            },
          };
        },
      },
    },
  };
  lint(original, { "census/records": "error" }, { census: plugin });
  return records;
}

/** The text of a top-level function, and of the context and core the lift declared for it. */
function statementsFor(code, file, name) {
  const { ast } = tsParser.parseForESLint(code, { range: true, loc: true, filePath: file, ecmaFeatures: { jsx: file.endsWith("x") } });
  const names = new Set([name, `${name}Hermetic`, `${name}Context`]);
  const found = [];
  for (const statement of ast.body) {
    const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? (statement.declaration ?? statement) : statement;
    const declared =
      node.type === "FunctionDeclaration"
        ? node.id?.name
        : node.type === "VariableDeclaration" && node.declarations.length === 1 && node.declarations[0].id.type === "Identifier"
          ? node.declarations[0].id.name
          : undefined;
    if (declared && names.has(declared)) found.push(code.slice(statement.range[0], statement.range[1]));
  }
  return found.join("\n\n");
}

function readResult(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(resultsDir, `${name}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The case studies' data: for each library, what the census, the fix and the
 * round trip found, and the examples as they were and as the fix leaves them.
 * Adds Effect's test-suite and benchmark results from their last runs.
 */
/** Writes what happened to every candidate function to .corpus/results/records.json, for looking one up. */
function runRecords() {
  return writeRecords(censusRecords());
}

function writeRecords(records) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, "records.json");
  fs.writeFileSync(file, `${JSON.stringify(records, null, 1)}\n`);
  console.log(`\nRecords: ${records.length} functions in ${path.relative(process.cwd(), file)}`);
  return records;
}

function runReport() {
  const records = writeRecords(censusRecords());
  const fixed = runFix();
  const roundtrip = runRoundtrip();
  const crosscheck = runCrosscheck();
  const libraries = LIBRARIES.map((library) => {
    const mine = records.filter((record) => libraryOf(record.file) === library);
    const count = (test) => mine.filter(test).length;
    const reasons = new Map();
    for (const record of mine.filter((r) => r.outcome === "skipped")) reasons.set(record.reason, (reasons.get(record.reason) ?? 0) + 1);
    const inLibrary = (entry) => libraryOf(entry.file) === library;
    const fixedFiles = fixed.files.filter(inLibrary);
    const roundFiles = roundtrip.files.filter(inLibrary);
    const typeErrors = (lines) => lines.filter((line) => libraryOf(line.replace(/^\d+ x /, "")) === library).length;
    const examples = (EXAMPLES[library.id] ?? []).map(([file, name]) => {
      const record = mine.find((r) => r.file === file && r.name === name);
      if (!record) throw new Error(`The example ${file}#${name} is not a candidate function`);
      return {
        file,
        name,
        line: record.line,
        outcome: record.outcome,
        reason: record.reason,
        before: statementsFor(fs.readFileSync(path.join(original, file), "utf8"), file, name),
        after: record.outcome === "skipped" ? undefined : statementsFor(fs.readFileSync(path.join(fixedDir, file), "utf8"), file, name),
      };
    });
    return {
      id: library.id,
      name: library.name,
      packages: library.packages.map((name) => ({ name, version: PACKAGES[name] })),
      files: fixedFiles.length,
      candidates: count((r) => r.outcome !== "unnamed" && r.outcome !== "method"),
      methods: count((r) => r.outcome === "method"),
      hermetic: count((r) => r.outcome === "hermetic"),
      hermeticMembers: count((r) => r.outcome === "hermetic" && r.member),
      direct: count((r) => r.outcome === "direct"),
      shared: count((r) => r.outcome === "shared"),
      skipped: count((r) => r.outcome === "skipped"),
      reasons: [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, count: n })),
      hoistedOnlyImports: count((r) => r.onlyImports),
      unnamed: count((r) => r.outcome === "unnamed"),
      unnamedPassedTo: Object.fromEntries(
        [...Map.groupBy(mine.filter((r) => r.outcome === "unnamed" && r.passedTo), (r) => r.passedTo)]
          .map(([callee, entries]) => [callee, entries.length])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5),
      ),
      validation: {
        filesChanged: fixedFiles.filter((f) => f.changed).length,
        parseErrors: fixedFiles.reduce((sum, f) => sum + f.unparsable, 0),
        sealedErrors: fixedFiles.reduce((sum, f) => sum + f.unsealed, 0),
        unsettledFiles: fixedFiles.filter((f) => f.unsettled).length,
        typeErrorsIntroduced: typeErrors(fixed.introduced),
        folded: roundFiles.reduce((sum, f) => sum + f.folded, 0),
        roundTripSkipped: roundFiles.reduce((sum, f) => sum + f.skipped, 0),
        roundTripDiffering: roundFiles.filter((f) => f.differs).length,
        roundTripTypeErrorsIntroduced: typeErrors(roundtrip.introduced),
      },
      examples,
    };
  });
  const generated = { date: new Date().toISOString(), ...provenance(), node: process.version };
  const data = {
    generated,
    libraries,
    crosscheck: {
      builds: PUBLISHED.map((build) => ({ build, version: PACKAGES[Object.keys(PACKAGES).find((name) => build.startsWith(`${name}/`))] })),
      files: crosscheck.files,
      functions: crosscheck.functions,
      methods: crosscheck.methods,
      classes: crosscheck.classes,
      hermetic: crosscheck.hermetic,
      same: crosscheck.same,
      agreed: crosscheck.agreed,
      moduleOnly: crosscheck.moduleOnly.map(({ file, line, name, sealedOnly }) => ({ file, line, name, reported: sealedOnly })),
      differing: crosscheck.differing.length,
    },
    effect: { tag: EFFECT.tag, lifted: readResult("effect-lifted"), unlifted: readResult("effect-unlifted"), bench: readResult("bench") },
  };
  fs.mkdirSync(path.dirname(siteData), { recursive: true });
  fs.writeFileSync(siteData, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\nReport: ${path.relative(process.cwd(), siteData)}, at ${generated.commit}${generated.dirty ? " with uncommitted changes" : ""}`);
  for (const library of libraries) {
    console.log(`  ${library.name}: ${library.candidates} candidates, ${library.hermetic} hermetic, ${library.direct + library.shared} lifted, ${library.skipped} skipped`);
  }
  console.log(`  Crosscheck: ${crosscheck.functions} functions, ${crosscheck.moduleOnly.length} differing only where sealed sees the module, ${crosscheck.differing.length} differing otherwise`);
  const runs = { lifted: "effect", unlifted: "effect --unlift", bench: "bench" };
  for (const [key, command] of Object.entries(runs)) {
    const result = data.effect[key];
    if (!result) console.log(`  No ${key} results yet: run npm run corpus -- ${command}`);
    else if (result.commit !== generated.commit || result.dirty !== generated.dirty) {
      console.log(`  The ${key} results come from ${result.commit ?? "an unknown commit"}${result.dirty ? " with uncommitted changes" : ""}: run npm run corpus -- ${command}`);
    }
  }
}

const command = process.argv[2] ?? "all";
prepare();
if (command === "census" || command === "all") runCensus();
if (command === "stress" || command === "all") runStress();
if (command === "fix" || command === "all") runFix();
if (command === "roundtrip" || command === "all") runRoundtrip();
if (command === "crosscheck" || command === "all") runCrosscheck();
if (command === "effect") runEffect({ unlift: process.argv.includes("--unlift") });
if (command === "bench") runBench();
if (command === "records") runRecords();
if (command === "report") runReport();
