// An experiment, not part of either package: turns the lift's shared contexts
// back into the object literals of getters the lift wrote before, to measure
// what writing them as class instances changed. `npm run corpus -- bench
// --literal` times both, next to the original.

import * as tsParser from "@typescript-eslint/parser";

/** Rewrites each `const x = new (class { accessors })();` in `code` as an object literal of the same accessors. */
export function toLiteralContexts(code, filename) {
  if (!code.includes("new (class {")) return { code, converted: 0 };
  const { ast } = tsParser.parseForESLint(code, {
    filePath: filename,
    sourceType: "module",
    range: true,
    loc: true,
    ecmaFeatures: { jsx: /x$/.test(filename) },
  });
  const lines = code.split("\n");
  const indent = (node) => /^\s*/.exec(lines[node.loc.start.line - 1] ?? "")?.[0] ?? "";
  const edits = [];
  for (const statement of ast.body) {
    const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (node?.type !== "VariableDeclaration" || node.kind !== "const" || node.declarations.length !== 1) continue;
    const init = node.declarations[0].init;
    if (init?.type !== "NewExpression" || init.arguments.length > 0 || init.callee.type !== "ClassExpression") continue;
    const members = init.callee.body.body;
    const accessors = members.every((member) => member.type === "MethodDefinition" && !member.static && (member.kind === "get" || member.kind === "set"));
    if (init.callee.superClass || members.length === 0 || !accessors) continue;
    const properties = members.map((member) => `${indent(member)}${code.slice(member.range[0], member.range[1])},`);
    edits.push({ range: init.range, text: `{\n${properties.join("\n")}\n${indent(statement)}}` });
  }
  let result = code;
  for (const { range, text } of edits.reverse()) result = result.slice(0, range[0]) + text + result.slice(range[1]);
  return { code: result, converted: edits.length };
}
