#!/usr/bin/env node
// Measures the rules against real code: TypeScript sources shipped by large
// open-source packages, pinned below and downloaded into .corpus/.
//
//   npm run corpus            census, stress and fix
//   npm run corpus -- census  which functions are hermetic, liftable, or need a person
//   npm run corpus -- stress  every function analyzed as if marked; nothing may throw
//   npm run corpus -- fix     `prefer-hermetic --fix` with lift: parses, sealed, settled, no new type errors
//   npm run corpus -- effect  lifts Effect's own source and runs its test suite (needs git and pnpm)
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
  const before = typeErrors(original);
  const after = typeErrors(fixedDir);
  const introduced = [];
  for (const [key, n] of after) {
    const extra = n - (before.get(key) ?? 0);
    if (extra > 0) introduced.push(`${extra} x ${key}`);
  }
  console.log(`  ${[...before.values()].reduce((a, b) => a + b, 0)} type errors before, ${[...after.values()].reduce((a, b) => a + b, 0)} after, ${introduced.length} kinds introduced`);
  for (const line of introduced.slice(0, 20)) console.log(`  ${line.slice(0, 220)}`);
}

/**
 * Behavior, not just types: lifts the source in a checkout of Effect's
 * repository at the pinned release and runs Effect's own test suite on it.
 */
function runEffect() {
  const checkout = path.join(root, "effect-repository");
  const shell = process.platform === "win32";
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
  const { changed, unparsable, unsealed, unsettled } = fixInPlace(path.join(checkout, "packages/effect/src"));
  const lifted = sourceFiles(path.join(checkout, "packages/effect/src"))
    .map((file) => fs.readFileSync(file, "utf8").match(/^(?:async )?function\*? ?\w+Hermetic\d*[<(]/gm)?.length ?? 0)
    .reduce((a, b) => a + b, 0);
  console.log(`\nEffect: ${changed} files changed, ${lifted} functions lifted`);
  console.log(`  ${unparsable} parse errors, ${unsealed} sealed errors, ${unsettled} files a second pass would change`);
  console.log("Running Effect's test suite on the lifted source...");
  execFileSync(path.join(checkout, "node_modules", ".bin", shell ? "vitest.cmd" : "vitest"), ["run", "--reporter=dot"], {
    cwd: path.join(checkout, "packages/effect"),
    stdio: "inherit",
    shell,
  });
}

const command = process.argv[2] ?? "all";
prepare();
if (command === "census" || command === "all") runCensus();
if (command === "stress" || command === "all") runStress();
if (command === "fix" || command === "all") runFix();
if (command === "effect") runEffect();
