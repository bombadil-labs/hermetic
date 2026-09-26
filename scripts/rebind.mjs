// An experiment, not part of either package: turns the lift's wrappers into
// bound functions, to measure what binding instead of wrapping would change.
// `npm run corpus -- bind` type-checks the result, and `effect --bind` and
// `bench --bind` run Effect's suite and benchmarks on it.
//
// A binding is rebound only in the exact shape the lift writes: a `const`
// whose whole body is `core.call(context, ...parameters)`, forwarding every
// parameter in order, where the core is a function declaration marked
// hermetic and the context is an object literal or the shared context the
// lift declares right after the binding. A function declaration keeps its
// wrapper, since a `const` can't run before its own line.
//
// The result, at cf984a9: 2,450 of the 2,498 lifted functions were rebound.
// Effect's 6,233 tests pass on the rebound source, but it has 904 new type
// errors, and the benchmarks gained little: the lifted copy ran +6%, +42% and
// +47% against the original, the bound one -8%, +24% and +51%, and a second
// copy of the original -4%, -9% and -5%. So the lift keeps its wrapper; see
// "Why a wrapper, not a bound function" in prefer-hermetic's docs.

import * as tsParser from "@typescript-eslint/parser";

const HELPER = "bindHermetic";

/** Rebinds every binding in `code` that has the lift's shape; returns the new code and how many it rebound. */
export function rebind(code, filename) {
  if (code.includes(HELPER)) return { code, rebound: 0 };
  const typescript = /\.[cm]?tsx?$/.test(filename);
  const { ast } = tsParser.parseForESLint(code, {
    filePath: filename,
    sourceType: "module",
    range: true,
    loc: true,
    comment: true,
    ecmaFeatures: { jsx: /x$/.test(filename) },
  });
  const statements = ast.body;
  const cores = new Set();
  const contexts = new Map();
  statements.forEach((statement, index) => {
    const node = declarationOf(statement);
    if (node?.type === "FunctionDeclaration" && node.id && isMarked(node)) cores.add(node.id.name);
    if (node?.type === "VariableDeclaration" && node.kind === "const" && node.declarations.length === 1) {
      const [declarator] = node.declarations;
      if (declarator.id.type === "Identifier" && declarator.init?.type === "ObjectExpression") contexts.set(declarator.id.name, { statement, index });
    }
  });

  const edits = [];
  let rebound = 0;
  statements.forEach((statement, index) => {
    const node = declarationOf(statement);
    if (node?.type !== "VariableDeclaration" || node.declarations.length !== 1) return;
    const fn = node.declarations[0].init;
    if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") return;
    const forwarding = forwardingCall(fn);
    if (!forwarding || !cores.has(forwarding.core)) return;
    const [context, ...args] = forwarding.args;
    if (!forwardsEveryParameter(fn, args)) return;
    let contextText;
    if (context?.type === "ObjectExpression") {
      contextText = code.slice(context.range[0], context.range[1]);
    } else if (context?.type === "Identifier" && contexts.get(context.name)?.index === index + 1) {
      // The binding now reads its context when it is declared, so the context moves in front of it.
      const moved = contexts.get(context.name).statement;
      contextText = context.name;
      const before = leadingStart(statement, ast.comments, code);
      edits.push({ range: [before, before], text: `${code.slice(moved.range[0], moved.range[1])}\n\n` });
      edits.push({ range: [moved.range[0], moved.range[1]], text: "" });
    } else {
      return;
    }
    edits.push({ range: fn.range, text: `${HELPER}(${forwarding.core}, ${contextText})` });
    rebound++;
  });
  if (rebound === 0) return { code, rebound };
  const helper = typescript
    ? `\n\nfunction ${HELPER}<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, env: NoInfer<T>): (...args: A) => R {\n  return fn.bind(env);\n}\n`
    : `\n\nfunction ${HELPER}(fn, env) {\n  return fn.bind(env);\n}\n`;
  edits.push({ range: [code.length, code.length], text: helper });
  return { code: apply(code, edits), rebound };
}

function declarationOf(statement) {
  return statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
}

function isMarked(fn) {
  for (const statement of fn.body.body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") return false;
    if (statement.directive === "use hermetic") return true;
  }
  return false;
}

/** `core.call(...args)` or `(core<T>).call(...args)` as the function's whole body. */
function forwardingCall(fn) {
  let expression = fn.body;
  if (fn.body.type === "BlockStatement") {
    const [only, ...rest] = fn.body.body;
    if (rest.length > 0 || only?.type !== "ReturnStatement" || !only.argument) return undefined;
    expression = only.argument;
  }
  if (expression.type !== "CallExpression" || expression.optional) return undefined;
  const callee = expression.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier" || callee.property.name !== "call") return undefined;
  const core = callee.object.type === "TSInstantiationExpression" ? callee.object.expression : callee.object;
  return core.type === "Identifier" ? { core: core.name, args: expression.arguments } : undefined;
}

/** Each parameter is passed on, in order, as the name it binds. */
function forwardsEveryParameter(fn, args) {
  if (args.length !== fn.params.length) return false;
  return fn.params.every((param, index) => {
    const arg = args[index];
    const name =
      param.type === "Identifier" ? param.name : param.type === "AssignmentPattern" ? param.left.name : param.type === "RestElement" ? param.argument.name : undefined;
    if (param.type === "RestElement") return arg?.type === "SpreadElement" && arg.argument.type === "Identifier" && arg.argument.name === name;
    return name !== undefined && arg?.type === "Identifier" && arg.name === name;
  });
}

/** Where a statement's leading comments start, so text inserted before it doesn't come between them. */
function leadingStart(statement, comments, code) {
  let start = statement.range[0];
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.range[1] > start) continue;
    if (code.slice(comment.range[1], start).trim() !== "") break;
    start = comment.range[0];
  }
  return start;
}

function apply(code, edits) {
  const sorted = [...edits].sort((a, b) => b.range[0] - a.range[0] || b.range[1] - a.range[1]);
  let result = code;
  for (const { range, text } of sorted) result = result.slice(0, range[0]) + text + result.slice(range[1]);
  return result;
}
