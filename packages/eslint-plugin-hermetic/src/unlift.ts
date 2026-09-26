import * as tsParser from "@typescript-eslint/parser";
import { AST_NODE_TYPES, ASTUtils, TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { childNodes, type Edit, looseComments, parameterSpan, renderComments } from "./ast.ts";
import { compose, Mapped, mappedAt, type MappedEdit, type SourceMap, sourceMap } from "./mapped.ts";
import { type FunctionNode, isFunctionNode } from "./marking.ts";

type SourceCode = TSESLint.SourceCode;
type Variable = TSESLint.Scope.Variable;

export interface UnliftResult {
  /** The module with every recognized binding folded back into its function. */
  readonly code: string;
  /** The bindings folded back, by name. */
  readonly unlifted: readonly string[];
  /** Bindings that forward to a core but were left alone, and why. */
  readonly skipped: readonly { readonly name: string; readonly line: number; readonly reason: string }[];
  /** With `sourceMap`, a source map from `code` back to the module it was given. */
  readonly map?: SourceMap;
}

export interface UnliftOptions {
  /** Also return a source map from the result back to the module. */
  readonly sourceMap?: boolean;
}

/**
 * The inverse of `prefer-hermetic`'s lift, for builds that want hermetic
 * source without its cost at run time. A binding that forwards to a hermetic
 * core becomes the function it came from again: the core's parameters and
 * body move back into it, each `this.name` reads `name`, and the core and its
 * context are removed.
 *
 * It applies only where that is exact: the core is used by the binding alone,
 * reads `this` only through the names its context provides, and none of them
 * is shadowed where it is read. Everything else is left as it is and listed in
 * `skipped`. The result is no longer hermetic, so it carries no directive.
 */
export function unlift(code: string, filename = "module.ts", options: UnliftOptions = {}): UnliftResult {
  const sourceCode = parse(code, filename);
  const edits: MappedEdit[] = [];
  const unlifted: string[] = [];
  const skipped: { name: string; line: number; reason: string }[] = [];
  for (const statement of sourceCode.ast.body) {
    const binding = functionOf(statement);
    const forwarding = binding && forwardingCall(binding);
    if (!binding || !forwarding) continue;
    const name = bindingName(binding);
    const plan = planUnlift(binding, forwarding.call, forwarding.core, sourceCode);
    if (plan === undefined) continue;
    if (typeof plan === "string") {
      skipped.push({ name, line: binding.loc.start.line, reason: plan });
      continue;
    }
    edits.push(...plan);
    unlifted.push(name);
  }
  const sorted = [...edits].sort((a, b) => a.range[0] - b.range[0]);
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i]?.range[0] ?? 0) < (sorted[i - 1]?.range[1] ?? 0)) throw new Error("unlift produced overlapping edits");
  }
  const result = compose(code, [0, code.length], sorted);
  return { code: result.text, unlifted, skipped, ...(options.sourceMap && { map: sourceMap(result, code, filename) }) };
}

function parse(code: string, filename: string): SourceCode {
  const { ast, services, scopeManager, visitorKeys } = tsParser.parseForESLint(code, {
    filePath: filename,
    sourceType: "module",
    ecmaFeatures: { jsx: !/\.[cm]?ts$/.test(filename) },
    range: true,
    loc: true,
    tokens: true,
    comment: true,
  });
  // The parser's visitor keys allow a missing entry; ESLint's type does not.
  const keys = visitorKeys as Record<string, readonly string[]>;
  // ESLint sets parents as it traverses; outside a lint run, set them here.
  const adopt = (node: TSESTree.Node, parent: TSESTree.Node | undefined): void => {
    (node as { parent?: TSESTree.Node }).parent = parent;
    for (const child of childNodes(node, keys)) adopt(child, node);
  };
  adopt(ast, undefined);
  return new TSESLint.SourceCode({ text: code, ast, parserServices: services, scopeManager, visitorKeys: keys });
}

/** The function a top-level statement declares, if it declares exactly one. */
function functionOf(statement: TSESTree.ProgramStatement): FunctionNode | undefined {
  const node =
    statement.type === AST_NODE_TYPES.ExportNamedDeclaration || statement.type === AST_NODE_TYPES.ExportDefaultDeclaration
      ? statement.declaration
      : statement;
  if (node?.type === AST_NODE_TYPES.FunctionDeclaration) return node;
  if (node?.type !== AST_NODE_TYPES.VariableDeclaration || node.declarations.length !== 1) return undefined;
  const init = node.declarations[0]?.init;
  return init?.type === AST_NODE_TYPES.ArrowFunctionExpression || init?.type === AST_NODE_TYPES.FunctionExpression ? init : undefined;
}

function bindingName(fn: FunctionNode): string {
  if (fn.id) return fn.id.name;
  return fn.parent.type === AST_NODE_TYPES.VariableDeclarator && fn.parent.id.type === AST_NODE_TYPES.Identifier
    ? fn.parent.id.name
    : "default";
}

/** `core.call(context, ...args)` or `(core<T>).call(...)` as the function's whole body. */
function forwardingCall(fn: FunctionNode): { call: TSESTree.CallExpression; core: TSESTree.Identifier } | undefined {
  let expression: TSESTree.Node = fn.body;
  if (fn.body.type === AST_NODE_TYPES.BlockStatement) {
    const [only, ...rest] = fn.body.body;
    if (rest.length > 0 || only?.type !== AST_NODE_TYPES.ReturnStatement || !only.argument) return undefined;
    expression = only.argument;
  }
  if (expression.type !== AST_NODE_TYPES.CallExpression || expression.optional) return undefined;
  const callee = expression.callee;
  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.optional ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    callee.property.name !== "call"
  ) {
    return undefined;
  }
  const core = callee.object.type === AST_NODE_TYPES.TSInstantiationExpression ? callee.object.expression : callee.object;
  return core.type === AST_NODE_TYPES.Identifier ? { call: expression, core } : undefined;
}

/** What `this.name` stands for in the core. */
interface Entry {
  /** The binding the context reads, or undefined for an undeclared global. */
  readonly variable: Variable | undefined;
  /** The name it is read by. */
  readonly name: string;
  /** Whether the context passes assignments through to it. */
  readonly writable: boolean;
}

/**
 * The edits that fold the binding back, or why it cannot be. Undefined when
 * the function is not a binding at all: its callee is not a hermetic function
 * declared in this module.
 */
function planUnlift(
  binding: FunctionNode,
  call: TSESTree.CallExpression,
  callee: TSESTree.Identifier,
  sourceCode: SourceCode,
): MappedEdit[] | string | undefined {
  const coreVariable = ASTUtils.findVariable(sourceCode.getScope(callee), callee);
  const core = coreVariable?.defs.length === 1 ? coreVariable.defs[0]?.node : undefined;
  if (core?.type !== AST_NODE_TYPES.FunctionDeclaration) return undefined;
  const directive = core.body.body[0];
  if (directive?.type !== AST_NODE_TYPES.ExpressionStatement || directive.directive !== "use hermetic") return undefined;

  if (core.parent.type !== AST_NODE_TYPES.Program) {
    return core.parent.type === AST_NODE_TYPES.ExportNamedDeclaration || core.parent.type === AST_NODE_TYPES.ExportDefaultDeclaration
      ? "the core is exported"
      : "the core is not declared at the top of the module";
  }
  if (binding.async || binding.generator) return "the binding is itself async or a generator";
  if (coreVariable?.references.some((reference) => reference.identifier !== callee)) return "the core is used elsewhere";
  if (binding.type === AST_NODE_TYPES.ArrowFunctionExpression && core.generator) return "an arrow cannot be a generator";

  const [contextArgument, ...forwarded] = call.arguments;
  const context = readContext(contextArgument, sourceCode);
  if (typeof context === "string") return context;

  const thisParameter = core.params[0]?.type === AST_NODE_TYPES.Identifier && core.params[0].name === "this" ? core.params[0] : undefined;
  const coreParams = thisParameter ? core.params.slice(1) : core.params;

  const edits: Edit[] = [];
  const problem = substituteThis(core, context.entries, sourceCode, edits);
  if (problem) return problem;
  const mismatch = matchParameters(binding, coreParams, forwarded, sourceCode, edits);
  if (mismatch) return mismatch;

  // The directive goes, with the whitespace the lift put before it.
  const beforeDirective = sourceCode.getTokenBefore(directive, { includeComments: true });
  edits.push({ range: [beforeDirective?.range[1] ?? directive.range[0], directive.range[1]], text: "" });
  if (thisParameter) {
    const comma = sourceCode.getTokenAfter(thisParameter);
    const next = comma?.value === "," ? sourceCode.getTokenAfter(comma, { includeComments: true }) : undefined;
    edits.push({ range: [thisParameter.range[0], next ? next.range[0] : thisParameter.range[1]], text: "" });
  }

  const text = sourceCode.text;
  const raw = (node: TSESTree.Node | undefined | null): Mapped => (node ? Mapped.copy(text, node.range) : Mapped.empty);
  // A named parameter reads as the binding still spells it, without annotations the lift added to the core.
  const restored = binding.params.flatMap((param, index) => {
    const coreParam = coreParams[index];
    const named =
      param.type === AST_NODE_TYPES.Identifier ||
      (param.type === AST_NODE_TYPES.AssignmentPattern && param.left.type === AST_NODE_TYPES.Identifier) ||
      (param.type === AST_NODE_TYPES.RestElement && param.argument.type === AST_NODE_TYPES.Identifier);
    const sameShape =
      coreParam?.type === param.type &&
      (coreParam.type !== AST_NODE_TYPES.AssignmentPattern || coreParam.left.type === AST_NODE_TYPES.Identifier) &&
      (coreParam.type !== AST_NODE_TYPES.RestElement || coreParam.argument.type === AST_NODE_TYPES.Identifier);
    return named && sameShape && coreParam ? [{ range: coreParam.range, text: raw(param) }] : [];
  });
  const within = (edit: Edit) => restored.some(({ range }) => edit.range[0] >= range[0] && edit.range[1] <= range[1]);
  const params = compose(text, parameterSpan(core, sourceCode), [...edits.filter((edit) => !within(edit)), ...restored]);
  // New text in the function stands for the start of the binding it replaces.
  const at = mappedAt(binding.range[0]);
  const signature = at`${raw(core.typeParameters)}(${params})${raw(core.returnType)}`;
  const block = compose(text, core.body.range, edits);
  // Comments the lift carried between the signature and the body. An arrow takes them after `=>`,
  // where a line break is allowed.
  const copied: (readonly [number, number])[] = [parameterSpan(core, sourceCode), core.body.range];
  for (const part of [core.typeParameters, core.returnType]) if (part) copied.push(part.range);
  const loose = looseComments(core, copied, sourceCode);
  const notes = Mapped.place(renderComments(loose, sourceCode, indentOf(sourceCode, core)), loose[0]?.range[0] ?? core.range[0]);
  let replacement: Mapped;
  if (binding.type === AST_NODE_TYPES.ArrowFunctionExpression) {
    replacement = at`${core.async ? "async " : ""}${signature} => ${notes}${conciseBody(core, sourceCode, edits) ?? block}`;
  } else {
    const name = binding.type === AST_NODE_TYPES.FunctionDeclaration ? ` ${binding.id?.name ?? ""}` : " ";
    replacement = at`${core.async ? "async " : ""}function${core.generator ? "*" : ""}${name}${signature} ${notes}${block}`;
  }

  const removals = [context.statement, core].flatMap((statement) => {
    if (!statement) return [];
    const before = sourceCode.getTokenBefore(statement, { includeComments: true });
    return [{ range: [before ? before.range[1] : 0, statement.range[1]] as const, text: "" }];
  });
  return [{ range: binding.range, text: replacement }, ...removals];
}

/**
 * The names a context provides. The lift passes either an object literal of
 * names, or a module constant of getters that return them and setters that
 * assign them. A getter may guard a global that may not exist under `typeof`;
 * unlifted, the name is read bare, as it was.
 */
function readContext(
  argument: TSESTree.CallExpressionArgument | undefined,
  sourceCode: SourceCode,
): { entries: Map<string, Entry>; statement?: TSESTree.Node } | string {
  const entries = new Map<string, Entry>();
  const resolve = (identifier: TSESTree.Identifier): Variable | undefined | "local" => {
    const variable = ASTUtils.findVariable(sourceCode.getScope(identifier), identifier) ?? undefined;
    return !variable || variable.scope.type === "module" || variable.scope.type === "global" ? variable : "local";
  };

  if (argument?.type === AST_NODE_TYPES.ObjectExpression) {
    for (const property of argument.properties) {
      if (
        property.type !== AST_NODE_TYPES.Property ||
        property.computed ||
        property.method ||
        property.kind !== "init" ||
        property.key.type !== AST_NODE_TYPES.Identifier ||
        property.value.type !== AST_NODE_TYPES.Identifier
      ) {
        return "the context literal holds something other than names";
      }
      const variable = resolve(property.value);
      if (variable === "local") return "the context reads a parameter or local of the binding";
      entries.set(property.key.name, { variable, name: property.value.name, writable: false });
    }
    return { entries };
  }

  if (argument?.type !== AST_NODE_TYPES.Identifier) return "the context is neither an object literal nor a name";
  const variable = ASTUtils.findVariable(sourceCode.getScope(argument), argument);
  const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  const declaration = def?.parent;
  if (
    def?.type !== "Variable" ||
    declaration?.type !== AST_NODE_TYPES.VariableDeclaration ||
    declaration.kind !== "const" ||
    declaration.declarations.length !== 1 ||
    declaration.parent.type !== AST_NODE_TYPES.Program ||
    def.node.init?.type !== AST_NODE_TYPES.ObjectExpression
  ) {
    return "the context is not a module constant holding an object literal";
  }
  if (variable?.references.some((reference) => !reference.init && reference.identifier !== argument)) {
    return "the context is used elsewhere";
  }
  const getters = new Map<string, TSESTree.Identifier>();
  const setters = new Map<string, TSESTree.Identifier>();
  for (const property of def.node.init.properties) {
    if (
      property.type !== AST_NODE_TYPES.Property ||
      property.computed ||
      property.key.type !== AST_NODE_TYPES.Identifier ||
      property.value.type !== AST_NODE_TYPES.FunctionExpression
    ) {
      return "a context member is not a plain accessor";
    }
    const key = property.key.name;
    const read = property.kind === "get" ? getterRead(property.value, key) : undefined;
    const written = property.kind === "set" ? setterWrite(property.value) : undefined;
    if (read) getters.set(key, read);
    else if (written) setters.set(key, written);
    else return `the context's accessor for '${key}' does more than read or write a name`;
  }
  for (const [key, read] of getters) {
    const target = resolve(read);
    const written = setters.get(key);
    if (target === "local") return `the context's getter for '${key}' reads a local`;
    if (written && (written.name !== read.name || resolve(written) !== target)) {
      return `the context's getter and setter for '${key}' reach different bindings`;
    }
    entries.set(key, { variable: target, name: read.name, writable: written !== undefined });
  }
  for (const key of setters.keys()) {
    if (!getters.has(key)) return `the context can write '${key}' but not read it`;
  }
  return { entries, statement: declaration };
}

/** The name a generated getter reads: `x`, or `x` under a `typeof x` guard. */
function getterRead(fn: TSESTree.FunctionExpression, key: string): TSESTree.Identifier | undefined {
  const [only, ...rest] = fn.body.body;
  if (fn.params.length > 0 || rest.length > 0 || only?.type !== AST_NODE_TYPES.ReturnStatement || !only.argument) return undefined;
  let value: TSESTree.Expression = only.argument;
  if (value.type === AST_NODE_TYPES.ConditionalExpression) {
    const { test, consequent } = value;
    if (
      test.type !== AST_NODE_TYPES.BinaryExpression ||
      test.operator !== "===" ||
      test.left.type !== AST_NODE_TYPES.UnaryExpression ||
      test.left.operator !== "typeof" ||
      test.left.argument.type !== AST_NODE_TYPES.Identifier ||
      test.left.argument.name !== key ||
      test.right.type !== AST_NODE_TYPES.Literal ||
      test.right.value !== "undefined" ||
      consequent.type !== AST_NODE_TYPES.Identifier ||
      consequent.name !== "undefined"
    ) {
      return undefined;
    }
    value = value.alternate;
  }
  if (value.type !== AST_NODE_TYPES.Identifier) return undefined;
  // A guard is the lift's own, for the global of the same name; a plain getter may read any name.
  return value === only.argument || value.name === key ? value : undefined;
}

/** The name a generated setter assigns: `set x(value) { x = value; }`. */
function setterWrite(fn: TSESTree.FunctionExpression): TSESTree.Identifier | undefined {
  const [param] = fn.params;
  const [only, ...rest] = fn.body.body;
  if (fn.params.length !== 1 || param?.type !== AST_NODE_TYPES.Identifier || rest.length > 0) return undefined;
  if (only?.type !== AST_NODE_TYPES.ExpressionStatement || only.expression.type !== AST_NODE_TYPES.AssignmentExpression) return undefined;
  const { operator, left, right } = only.expression;
  if (operator !== "=" || left.type !== AST_NODE_TYPES.Identifier || right.type !== AST_NODE_TYPES.Identifier) return undefined;
  return right.name === param.name && left.name !== param.name ? left : undefined;
}

/**
 * Rewrites each `this.name` the core reads as the name itself. Every `this`
 * that belongs to the core must be such a read, of a name the context provides,
 * and must resolve to the same binding once `this.` is gone.
 */
function substituteThis(
  core: TSESTree.FunctionDeclaration,
  entries: ReadonlyMap<string, Entry>,
  sourceCode: SourceCode,
  edits: Edit[],
): string | undefined {
  const coreScope = sourceCode.scopeManager?.acquire(core);
  const moduleScope = coreScope?.upper;
  if (!coreScope || !moduleScope) return "the core has no scope";
  // The binding forwards only its declared parameters, so the core's `arguments` may hold fewer.
  if ((coreScope.set.get("arguments")?.references.length ?? 0) > 0) return "the core uses arguments";
  let problem: string | undefined;
  const visit = (node: TSESTree.Node): void => {
    if (problem) return;
    if (node !== core && isFunctionNode(node) && node.type !== AST_NODE_TYPES.ArrowFunctionExpression) return;
    if (node.type === AST_NODE_TYPES.ClassBody) {
      if (containsOwnThis(node, sourceCode)) problem = "the core uses this inside a class body";
      return;
    }
    if (node.type === AST_NODE_TYPES.Super) problem = "the core uses super";
    if (node.type === AST_NODE_TYPES.MetaProperty && node.meta.name === "new") problem = "the core uses new.target";
    if (node.type === AST_NODE_TYPES.ThisExpression) {
      problem = substituteSite(node, entries, coreScope, moduleScope, sourceCode, edits);
      return;
    }
    for (const child of childNodes(node, sourceCode.visitorKeys)) visit(child);
  };
  const [first, ...others] = core.params;
  const params = first?.type === AST_NODE_TYPES.Identifier && first.name === "this" ? others : core.params;
  for (const param of params) visit(param);
  visit(core.body);
  return problem;
}

/** True when `this` appears in a class body outside the functions nested in it: a computed key or a field. */
function containsOwnThis(classBody: TSESTree.ClassBody, sourceCode: SourceCode): boolean {
  const visit = (node: TSESTree.Node): boolean => {
    if (node.type === AST_NODE_TYPES.ThisExpression) return true;
    if (isFunctionNode(node) && node.type !== AST_NODE_TYPES.ArrowFunctionExpression) return false;
    return [...childNodes(node, sourceCode.visitorKeys)].some(visit);
  };
  return visit(classBody);
}

function substituteSite(
  node: TSESTree.ThisExpression,
  entries: ReadonlyMap<string, Entry>,
  coreScope: TSESLint.Scope.Scope,
  moduleScope: TSESLint.Scope.Scope,
  sourceCode: SourceCode,
  edits: Edit[],
): string | undefined {
  const member = node.parent;
  if (
    member.type !== AST_NODE_TYPES.MemberExpression ||
    member.object !== node ||
    member.computed ||
    member.optional ||
    member.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return "the core uses this other than to read a name";
  }
  const key = member.property.name;
  const entry = entries.get(key);
  if (!entry) return `the core reads 'this.${key}', which its context does not provide`;
  const write = writeKind(member);
  if (write === "delete") return `the core deletes 'this.${key}'`;
  if (write && !entry.writable) return `the core assigns 'this.${key}', which its context cannot write`;

  // The name must reach the same binding from here as the context's accessor did.
  for (let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(member); scope && scope !== moduleScope; scope = scope.upper) {
    if (scope.set.get(entry.name)?.isValueVariable) return `a local '${entry.name}' in the core shadows the binding`;
    if (scope === coreScope) break;
  }
  if ((ASTUtils.findVariable(moduleScope, entry.name) ?? undefined) !== entry.variable) {
    return `'${entry.name}' in the core would reach a different binding`;
  }

  // The lift calls a global the original called bare as `(0, this.name)(…)`; fold it back to `name(…)`.
  const bare = bareCallee(member, sourceCode);
  if (bare) {
    edits.push({ range: bare, text: entry.name });
    return undefined;
  }

  // The lift expands `{ name }` to `{ name: this.name }`; fold it back.
  const property = member.parent.type === AST_NODE_TYPES.AssignmentPattern ? member.parent.parent : member.parent;
  const value = member.parent.type === AST_NODE_TYPES.AssignmentPattern ? member.parent : member;
  if (
    property.type === AST_NODE_TYPES.Property &&
    property.value === value &&
    !property.computed &&
    !property.method &&
    property.kind === "init" &&
    property.key.type === AST_NODE_TYPES.Identifier &&
    property.key.name === entry.name
  ) {
    edits.push({ range: [property.key.range[0], member.range[1]], text: entry.name });
  } else {
    edits.push({ range: member.range, text: entry.name });
  }
  return undefined;
}

/** The range of `(0, member)` when it is called as a callee or a tag, the form the lift writes for a bare call. */
function bareCallee(member: TSESTree.MemberExpression, sourceCode: SourceCode): [number, number] | undefined {
  const sequence = member.parent;
  if (sequence.type !== AST_NODE_TYPES.SequenceExpression || sequence.expressions.length !== 2) return undefined;
  const [zero, last] = sequence.expressions;
  if (last !== member || zero?.type !== AST_NODE_TYPES.Literal || zero.value !== 0 || zero.raw !== "0") return undefined;
  const call = sequence.parent;
  const called =
    (call.type === AST_NODE_TYPES.CallExpression && call.callee === sequence) ||
    (call.type === AST_NODE_TYPES.TaggedTemplateExpression && call.tag === sequence);
  const open = sourceCode.getTokenBefore(sequence);
  const close = sourceCode.getTokenAfter(sequence);
  if (!called || open?.value !== "(" || close?.value !== ")") return undefined;
  return [open.range[0], close.range[1]];
}

/** Whether `member` is written: assigned, updated, destructured into, or deleted. */
function writeKind(member: TSESTree.MemberExpression): "write" | "delete" | undefined {
  let node: TSESTree.Node = member;
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    switch (parent.type) {
      case AST_NODE_TYPES.AssignmentExpression:
        return parent.left === node ? "write" : undefined;
      case AST_NODE_TYPES.UpdateExpression:
        return "write";
      case AST_NODE_TYPES.UnaryExpression:
        return parent.operator === "delete" ? "delete" : undefined;
      case AST_NODE_TYPES.ForInStatement:
      case AST_NODE_TYPES.ForOfStatement:
        return parent.left === node ? "write" : undefined;
      case AST_NODE_TYPES.AssignmentPattern:
        if (parent.left !== node) return undefined;
        break;
      case AST_NODE_TYPES.ArrayPattern:
      case AST_NODE_TYPES.ObjectPattern:
      case AST_NODE_TYPES.RestElement:
        break;
      case AST_NODE_TYPES.Property:
        if (parent.parent.type !== AST_NODE_TYPES.ObjectPattern || parent.value !== node) return undefined;
        break;
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Checks that the binding forwards exactly its parameters, and that each
 * matches the core's: the same name, or the lift's stand-in for a pattern,
 * with the same default. Defaults are compared as the core's text reads once
 * `this.` is gone.
 */
function matchParameters(
  binding: FunctionNode,
  coreParams: readonly TSESTree.Parameter[],
  forwarded: readonly TSESTree.CallExpressionArgument[],
  sourceCode: SourceCode,
  edits: readonly Edit[],
): string | undefined {
  const mismatch = "the binding's parameters do not match the core's";
  if (binding.params.length !== coreParams.length || forwarded.length !== binding.params.length) return mismatch;
  const text = sourceCode.text;
  const sameDefault = (bindingDefault: TSESTree.Expression, coreDefault: TSESTree.Expression): boolean =>
    text.slice(bindingDefault.range[0], bindingDefault.range[1]) === compose(text, coreDefault.range, edits).text;
  for (const [index, param] of binding.params.entries()) {
    const core = coreParams[index];
    const argument = forwarded[index];
    if (!core || !argument) return mismatch;
    const passes = (name: string): boolean => argument.type === AST_NODE_TYPES.Identifier && argument.name === name;
    const spreads = (name: string): boolean =>
      argument.type === AST_NODE_TYPES.SpreadElement &&
      argument.argument.type === AST_NODE_TYPES.Identifier &&
      argument.argument.name === name;
    switch (param.type) {
      case AST_NODE_TYPES.Identifier: {
        const same = core.type === AST_NODE_TYPES.Identifier && core.name === param.name;
        const pattern = core.type === AST_NODE_TYPES.ObjectPattern || core.type === AST_NODE_TYPES.ArrayPattern;
        if (!(same || pattern) || !passes(param.name)) return mismatch;
        break;
      }
      case AST_NODE_TYPES.AssignmentPattern: {
        if (param.left.type !== AST_NODE_TYPES.Identifier || !passes(param.left.name)) return mismatch;
        if (core.type !== AST_NODE_TYPES.AssignmentPattern || !sameDefault(param.right, core.right)) return mismatch;
        const same = core.left.type === AST_NODE_TYPES.Identifier && core.left.name === param.left.name;
        if (!same && core.left.type !== AST_NODE_TYPES.ObjectPattern && core.left.type !== AST_NODE_TYPES.ArrayPattern) return mismatch;
        break;
      }
      case AST_NODE_TYPES.RestElement: {
        if (param.argument.type !== AST_NODE_TYPES.Identifier || !spreads(param.argument.name)) return mismatch;
        if (core.type !== AST_NODE_TYPES.RestElement) return mismatch;
        if (core.argument.type === AST_NODE_TYPES.Identifier && core.argument.name !== param.argument.name) return mismatch;
        break;
      }
      default:
        return mismatch;
    }
  }
  return undefined;
}

/**
 * The expression an arrow's body was, when the core is just the directive and
 * a return: the lift's form for an expression-bodied arrow. Comments outside
 * the returned expression keep the block.
 */
function conciseBody(core: TSESTree.FunctionDeclaration, sourceCode: SourceCode, edits: readonly Edit[]): Mapped | undefined {
  const [, returned, ...rest] = core.body.body;
  if (rest.length > 0 || returned?.type !== AST_NODE_TYPES.ReturnStatement || !returned.argument) return undefined;
  const keyword = sourceCode.getFirstToken(returned);
  const last = sourceCode.getLastToken(returned);
  if (!keyword || !last) return undefined;
  const end = last.value === ";" ? last.range[0] : returned.range[1];
  const outside = sourceCode
    .getCommentsInside(core.body)
    .some((comment) => comment.range[0] < keyword.range[1] || comment.range[1] > end);
  if (outside) return undefined;
  const expression = compose(sourceCode.text, [keyword.range[1], end], edits).trim();
  // An object literal, or a comma sequence, must be parenthesized to stay a concise body.
  const bare = returned.argument.type !== AST_NODE_TYPES.SequenceExpression && sourceCode.getFirstToken(returned.argument)?.value !== "{";
  // The lift's own parentheses, which keep a line comment from ending `return`.
  const guarded = /^\((\/[/*][\s\S]*)\n\)$/.test(expression.text);
  if (guarded && bare) return expression.slice(1, expression.text.length - 2);
  const wrapped = sourceCode.getTokenBefore(returned.argument)?.value === "(";
  return wrapped || bare ? expression : mappedAt(returned.argument.range[0])`(${expression})`;
}

function indentOf(sourceCode: SourceCode, node: TSESTree.Node): string {
  return /^\s*/.exec(sourceCode.lines[node.loc.start.line - 1] ?? "")?.[0] ?? "";
}
