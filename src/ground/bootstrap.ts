import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import type { Linter as ESLintLinter } from "eslint";
import { type FunctionNode, isFunctionNode, isMarkedHermetic } from "../marking.ts";
import { eraseTypes, NonErasableSyntaxError } from "./erase.ts";
import { createGround, type Ground } from "./ground.ts";

// Loaded lazily: projects on the default ground never pay for the parser.
const require = createRequire(import.meta.url);

const TIMEOUT_MS = 1000;

export class GroundBootstrapError extends Error {
  override name = "GroundBootstrapError";
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly source: string;
  readonly ground: Ground;
}

const cache = new Map<string, CacheEntry>();

/**
 * Loads the ground from a bootstrap module. The bootstrap is a hermetic
 * function that receives a realm and returns `{ allow, deny }`.
 *
 * 1. Lint the bootstrap with the rule itself, on the default ground, and
 *    refuse to go on unless it is marked hermetic and passes.
 * 2. Erase its TypeScript syntax and evaluate its source text alone in a
 *    fresh `node:vm` context. Passing the lint is what makes this safe: the
 *    function touches nothing but the realm it is handed, so it runs the same
 *    outside its module. (A vm context is not a security boundary; the lint is.)
 * 3. Read the keys of `allow` and the paths in `deny`.
 *
 * Results are cached per file and reloaded when the file changes.
 */
export function loadGround(file: string, rule: TSESLint.AnyRuleModule): Ground {
  const stat = statFile(file);
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.ground;
  const source = fs.readFileSync(file, "utf8");
  const ground = cached?.source === source ? cached.ground : evaluateBootstrap(file, source, rule);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, source, ground });
  return ground;
}

function statFile(file: string): fs.Stats {
  try {
    return fs.statSync(file);
  } catch (error) {
    throw new GroundBootstrapError(`Cannot read the ground bootstrap at ${file}: ${describe(error)}`);
  }
}

function evaluateBootstrap(file: string, source: string, rule: TSESLint.AnyRuleModule): Ground {
  const { Linter } = require("eslint") as typeof import("eslint");
  const parser = require("@typescript-eslint/parser") as ESLintLinter.Parser;
  const linter = new Linter({ cwd: path.dirname(file) });
  const config = {
    files: ["**"],
    languageOptions: { parser, sourceType: "module", ecmaVersion: "latest" },
    // Suppression comments must not let a bootstrap that is not hermetic run.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    plugins: { hermetic: { rules: { sealed: rule } } },
    rules: { "hermetic/sealed": "error" },
  } as unknown as ESLintLinter.Config;
  const messages = linter.verify(source, [config], { filename: file });

  const fatal = messages.find((message) => message.fatal);
  if (fatal) {
    throw new GroundBootstrapError(
      `Cannot parse the ground bootstrap at ${file}: ${fatal.line}:${fatal.column} ${fatal.message}`,
    );
  }

  const sourceCode = linter.getSourceCode() as unknown as TSESLint.SourceCode;
  const bootstrap = findBootstrap(sourceCode.ast);
  if (!bootstrap) {
    throw new GroundBootstrapError(
      `No ground bootstrap found in ${file}. Export a function named 'ground', or a default function, ` +
        "that receives the realm and returns { allow, deny }.",
    );
  }
  if (!isMarkedHermetic(bootstrap, sourceCode)) {
    throw new GroundBootstrapError(
      `The ground bootstrap in ${file} must be marked hermetic, with a "use hermetic" directive or an @hermetic ` +
        "JSDoc tag, so that it can be linted before it runs.",
    );
  }
  const [start, end] = bootstrap.range;
  const problems = messages.filter((message) => {
    if (message.ruleId !== "hermetic/sealed") return false;
    const offset = sourceCode.getIndexFromLoc({ line: message.line, column: message.column - 1 });
    return offset >= start && offset < end;
  });
  if (problems.length > 0) {
    const list = problems.map((problem) => `  ${problem.line}:${problem.column}  ${problem.message}`).join("\n");
    throw new GroundBootstrapError(`The ground bootstrap in ${file} is not hermetic, so it will not be run:\n${list}`);
  }

  let code: string;
  try {
    code = eraseTypes(sourceCode.text, bootstrap, sourceCode.visitorKeys);
  } catch (error) {
    if (!(error instanceof NonErasableSyntaxError)) throw error;
    const { line, column } = error.node.loc.start;
    throw new GroundBootstrapError(
      `${error.message}, which a ground bootstrap needs so it can run without a compiler (${file}:${line}:${column + 1}).`,
    );
  }
  const result = run(file, code, bootstrap.loc.start);
  try {
    return createGround(result.allow, result.deny);
  } catch (error) {
    throw new GroundBootstrapError(`The ground bootstrap in ${file} returned an invalid ground: ${describe(error)}`);
  }
}

/** Finds the export named `ground`, falling back to the default export. */
function findBootstrap(program: TSESTree.Program): FunctionNode | undefined {
  const locals = new Map<string, FunctionNode>();
  const exported = new Map<string, FunctionNode>();
  const specifiers: [local: string, exported: string][] = [];

  for (const statement of program.body) {
    const declaration =
      statement.type === AST_NODE_TYPES.ExportNamedDeclaration ? statement.declaration : statement;
    const declared = new Map<string, FunctionNode>();
    if (declaration?.type === AST_NODE_TYPES.FunctionDeclaration && declaration.id) {
      declared.set(declaration.id.name, declaration);
    } else if (declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === AST_NODE_TYPES.Identifier && isFunctionNode(declarator.init)) {
          declared.set(declarator.id.name, declarator.init);
        }
      }
    }
    for (const [name, fn] of declared) {
      locals.set(name, fn);
      if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) exported.set(name, fn);
    }

    if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration && !statement.declaration && !statement.source) {
      for (const specifier of statement.specifiers) {
        specifiers.push([moduleExportName(specifier.local), moduleExportName(specifier.exported)]);
      }
    } else if (statement.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
      const value = statement.declaration;
      if (isFunctionNode(value)) exported.set("default", value);
      else if (value.type === AST_NODE_TYPES.Identifier) specifiers.push([value.name, "default"]);
    }
  }
  for (const [local, name] of specifiers) {
    const fn = locals.get(local);
    if (fn) exported.set(name, fn);
  }
  return exported.get("ground") ?? exported.get("default");
}

function moduleExportName(node: TSESTree.Identifier | TSESTree.StringLiteral): string {
  return node.type === AST_NODE_TYPES.Identifier ? node.name : node.value;
}

/**
 * Runs the bootstrap's source text in a fresh realm with code generation
 * disabled and a timeout. Validation happens inside the realm, with
 * intrinsics captured before the bootstrap runs, and only a JSON string
 * crosses back. The bootstrap keeps its original line and column, so errors
 * point into the ground file.
 */
function run(file: string, code: string, at: TSESTree.Position): { allow: string[]; deny: string[] } {
  const script = [
    '"use strict"; const $bootstrap = (',
    " ".repeat(at.column) + code,
    ");",
    "const $keys = Object.keys, $isArray = Array.isArray, $stringify = JSON.stringify;",
    "(() => {",
    "  const $fail = (error) => $stringify({ error });",
    "  const $result = $bootstrap(globalThis);",
    "  if ($result === null || typeof $result !== 'object') return $fail('must return an object with allow and deny');",
    "  if (typeof $result.then === 'function') return $fail('must return its ground synchronously, not a promise');",
    "  const $allow = $result.allow;",
    "  if ($allow === null || typeof $allow !== 'object') return $fail('must return an allow object keyed by global name');",
    "  const $deny = $result.deny === undefined ? [] : $result.deny;",
    "  if (!$isArray($deny) || !$deny.every((path) => typeof path === 'string')) {",
    "    return $fail('must return deny as an array of strings');",
    "  }",
    "  return $stringify({ allow: $keys($allow), deny: $deny });",
    "})()",
  ].join("\n");
  let compiled: vm.Script;
  try {
    // The bootstrap starts on the script's second line.
    compiled = new vm.Script(script, { filename: file, lineOffset: at.line - 2 });
  } catch (error) {
    throw new GroundBootstrapError(
      `The ground bootstrap in ${file} does not compile once its types are erased${location(error, file)}: ${describe(error)}`,
    );
  }
  const context = vm.createContext(Object.create(null), {
    name: `ground bootstrap ${file}`,
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  let output: unknown;
  try {
    output = compiled.runInContext(context, { timeout: TIMEOUT_MS });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new GroundBootstrapError(`The ground bootstrap in ${file} did not return within ${TIMEOUT_MS}ms.`);
    }
    throw new GroundBootstrapError(`The ground bootstrap threw${location(error, file)}: ${describe(error)}`);
  }
  const parsed = typeof output === "string" ? (JSON.parse(output) as Record<string, unknown>) : {};
  if (typeof parsed.error === "string") {
    throw new GroundBootstrapError(`The ground bootstrap in ${file} ${parsed.error}.`);
  }
  return parsed as { allow: string[]; deny: string[] };
}

/**
 * ` at file:line:column`, from the first stack frame in the ground file. Node
 * prefixes vm errors with a `file:line` header, so a frame with a column wins.
 */
function location(error: unknown, file: string): string {
  const stack = typeof error === "object" && error !== null && "stack" in error ? String(error.stack) : "";
  let lineOnly: string | undefined;
  for (let at = stack.indexOf(`${file}:`); at !== -1; at = stack.indexOf(`${file}:`, at + 1)) {
    const match = /^(\d+)(?::(\d+))?/.exec(stack.slice(at + file.length + 1));
    if (match?.[2]) return ` at ${file}:${match[1]}:${match[2]}`;
    if (match) lineOnly ??= ` at ${file}:${match[1]}`;
  }
  return lineOnly ?? ` in ${file}`;
}

/** Errors from the vm come from another realm, so `instanceof Error` does not apply. */
function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}
