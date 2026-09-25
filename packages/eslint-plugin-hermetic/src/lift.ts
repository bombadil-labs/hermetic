import { AST_NODE_TYPES, AST_TOKEN_TYPES, ASTUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { applyEdits, arrowToken, childNodes, type Edit, LINE_BREAK, looseComments, parameterSpan, renderComments } from "./ast.ts";
import { type Environment, isAmbient, isTypeOnly, type MessageIds, type Problem } from "./analysis.ts";
import { directiveInsertion, type FunctionNode, isFunctionNode, isMarkedHermetic } from "./marking.ts";

type Reference = TSESLint.Scope.Reference;
type SourceCode = Readonly<TSESLint.SourceCode>;

/** Problems a lift can resolve: references to module bindings and globals. */
const LIFTABLE: ReadonlySet<MessageIds> = new Set(["freeVariable"]);

/** A binding the lift moves into the function's context. */
interface Lifted {
  readonly name: string;
  readonly global: boolean;
  /** Written by the function, so the context needs a setter. */
  writable: boolean;
  /** A global called directly. A bare call runs with the global object as its receiver; keep it that way. */
  callsHost: boolean;
  /** A global read under `typeof`, which must not throw when the global does not exist. */
  guarded: boolean;
  /**
   * Always initialized and never reassigned whenever the function can run, so
   * the binding can pass the value itself instead of a getter.
   */
  direct: boolean;
  /**
   * For a `const` holding a primitive literal, the type TypeScript widens it to
   * in a mutable declaration: `number` for `const BASE = 2`. A `typeof`
   * annotation would keep the literal `2`, so unannotated mutable declarations
   * in the core get this type spelled out.
   */
  readonly widened?: string;
}

export interface LiftPlan {
  readonly fn: FunctionNode;
  readonly coreName: string;
  /** The top-level statement that holds the function, so the core can follow it. */
  readonly statement: TSESTree.Node;
  readonly lifted: ReadonlyMap<string, Lifted>;
  readonly identifiers: readonly TSESTree.Identifier[];
  /**
   * The shared context the binding passes, declared once right after it, when
   * some lifted binding must be read through a getter. Undefined when every
   * value can be passed directly, in a fresh object literal.
   */
  readonly contextName?: string;
}

/** Why a function was not lifted: the first check it failed. */
export type LiftBlocker =
  | "structural-only types"
  | "an object member"
  | "not declared at module level"
  | "a named function expression"
  | "a typed variable"
  | "several declarators"
  | "a this parameter or asserts"
  | "uses its own this, arguments or new.target"
  | "suppresses type errors"
  | "a default reads a destructured parameter"
  | "a default calls a function"
  | "a generic rest parameter"
  | "an inline key-remapped mapped type"
  | "reads the stack"
  | "JSX"
  | "lexical this or new.target"
  | "super"
  | "import.meta or import()"
  | "writes a constant or import"
  | "a lifted name inside a nested function or class"
  | "a const enum"
  | "a declaration that reads unsettled names"
  | "another escape";

/**
 * Decides whether `fn` can be split into a hermetic core and a binding without
 * changing behavior, and what moves into the context. Returns undefined when a
 * person should decide; `tryLift` says why.
 */
export function planLift(fn: FunctionNode, problems: readonly Problem[], env: Environment): LiftPlan | undefined {
  const result = tryLift(fn, problems, env);
  return typeof result === "string" ? undefined : result;
}

/** What `tryLift` may assume beyond what the lift does. */
export interface LiftAssumptions {
  /**
   * Imported bindings are initialized before any function that reads them
   * runs, and do not change while it runs. An import cycle breaks the first
   * and an exported `let` the second, so the lift does not assume it; the
   * corpus report does, to count what an opt-in would change.
   */
  readonly importsSettled?: boolean;
}

/** The lift's plan for `fn`, or the reason it has none. */
export function tryLift(
  fn: FunctionNode,
  problems: readonly Problem[],
  env: Environment,
  assumptions: LiftAssumptions = {},
): LiftPlan | LiftBlocker {
  if (env.structuralOnly) return "structural-only types";
  const site = liftSite(fn);
  if (typeof site === "string") return site;
  if (usesOwnReceiver(fn, env)) return "uses its own this, arguments or new.target";
  if (suppressesTypeErrors(fn, env)) return "suppresses type errors";
  if (defaultReadsPattern(fn)) return "a default reads a destructured parameter";
  if (defaultMayRunTwice(fn, env)) return "a default calls a function";
  if (!forwardsRestExactly(fn)) return "a generic rest parameter";
  if (remapsKeysInline(fn, env)) return "an inline key-remapped mapped type";
  if (inspectsStack(fn, env)) return "reads the stack";

  const references: Reference[] = [];
  for (const problem of problems) {
    if (!problem.reference || !LIFTABLE.has(problem.messageId)) return PROBLEM_BLOCKERS[problem.messageId] ?? "another escape";
    references.push(problem.reference);
  }
  // Once the body moves into the core, a declaration's calls to itself must go through the public binding.
  const scope = env.sourceCode.scopeManager?.acquire(fn);
  if (fn.type === AST_NODE_TYPES.FunctionDeclaration) {
    for (const reference of scope?.through ?? []) {
      if (!isTypeOnly(reference, fn) && reference.resolved?.defs.some((def) => def.node === fn)) {
        references.push(reference);
      }
    }
  }
  if (references.length === 0) return "not declared at module level";

  const lifted = new Map<string, Lifted>();
  const identifiers: TSESTree.Identifier[] = [];
  for (const reference of references) {
    const entry = classify(reference, site, assumptions);
    if (typeof entry === "string") return entry;
    if (!readsCoreThis(reference.identifier, fn)) return "a lifted name inside a nested function or class";
    const existing = lifted.get(entry.name);
    if (existing) {
      existing.writable ||= entry.writable;
      existing.callsHost ||= entry.callsHost;
      existing.guarded ||= entry.guarded;
      existing.direct &&= entry.direct;
    } else {
      lifted.set(entry.name, entry);
    }
    identifiers.push(reference.identifier as TSESTree.Identifier);
  }
  const direct = [...lifted.values()].every((entry) => entry.direct);
  // A function declaration can run before any statement of its module, a shared context's included.
  if (!direct && site.hoisted) return "a declaration that reads unsettled names";
  const coreName = freshName(`${site.name}Hermetic`, env, fn);
  const contextName = direct ? undefined : freshName(`${site.name}Context`, env, fn);
  return { fn, coreName, statement: site.statement, lifted, identifiers, contextName };
}

interface LiftSite {
  readonly name: string;
  /** The top-level statement that declares the binding. */
  readonly statement: TSESTree.Node;
  /** A function declaration, callable before any statement of its module has run. */
  readonly hoisted: boolean;
}

/** Only module-level declarations and single `const`/`let` initializers keep their callers intact. */
function liftSite(fn: FunctionNode): LiftSite | LiftBlocker {
  const parent = fn.parent;
  if (
    parent.type === AST_NODE_TYPES.Property ||
    parent.type === AST_NODE_TYPES.MethodDefinition ||
    parent.type === AST_NODE_TYPES.PropertyDefinition
  ) {
    return "an object member";
  }
  if (fn.params.some((param) => param.type === AST_NODE_TYPES.Identifier && param.name === "this")) return "a this parameter or asserts";
  const returns = fn.returnType?.typeAnnotation;
  if (returns?.type === AST_NODE_TYPES.TSTypePredicate && returns.asserts) return "a this parameter or asserts";
  if (fn.type === AST_NODE_TYPES.FunctionDeclaration) {
    if (!fn.id) return "not declared at module level";
    if (parent.type === AST_NODE_TYPES.Program) return { name: fn.id.name, statement: fn, hoisted: true };
    if (
      (parent.type === AST_NODE_TYPES.ExportNamedDeclaration || parent.type === AST_NODE_TYPES.ExportDefaultDeclaration) &&
      parent.parent.type === AST_NODE_TYPES.Program
    ) {
      return { name: fn.id.name, statement: parent, hoisted: true };
    }
    return "not declared at module level";
  }
  // A named function expression binds its own name, which the core could not see.
  if (fn.type === AST_NODE_TYPES.FunctionExpression && fn.id) return "a named function expression";
  if (parent.type !== AST_NODE_TYPES.VariableDeclarator || parent.init !== fn) return "not declared at module level";
  if (parent.id.type !== AST_NODE_TYPES.Identifier) return "not declared at module level";
  // `const f: Fn = (x) => ...` types the function, and what it returns, from `Fn`; the core would lose that context.
  if (parent.id.typeAnnotation) return "a typed variable";
  const declaration = parent.parent;
  if (declaration.type !== AST_NODE_TYPES.VariableDeclaration) return "not declared at module level";
  if (declaration.declarations.length !== 1) return "several declarators";
  const outer = declaration.parent;
  if (outer.type === AST_NODE_TYPES.Program) return { name: parent.id.name, statement: declaration, hoisted: false };
  if (outer.type === AST_NODE_TYPES.ExportNamedDeclaration && outer.parent.type === AST_NODE_TYPES.Program) {
    return { name: parent.id.name, statement: outer, hoisted: false };
  }
  return "not declared at module level";
}

/** Problems the lift cannot resolve, by the reason they give. */
const PROBLEM_BLOCKERS: Partial<Record<MessageIds, LiftBlocker>> = {
  jsx: "JSX",
  lexicalThis: "lexical this or new.target",
  lexicalNewTarget: "lexical this or new.target",
  superReference: "super",
  importMeta: "import.meta or import()",
  dynamicImport: "import.meta or import()",
};

/** `@ts-expect-error` and `@ts-ignore` target lines that move; the author should decide. */
function suppressesTypeErrors(fn: FunctionNode, env: Environment): boolean {
  return env.sourceCode
    .getCommentsInside(fn)
    .some((comment) => /@ts-(?:expect-error|ignore|nocheck)\b/.test(comment.value));
}

/**
 * The binding keeps each default value, so it may not read a name that only a
 * destructured parameter before it binds: the binding forwards that parameter whole.
 */
function defaultReadsPattern(fn: FunctionNode): boolean {
  const seenPattern = fn.params.findIndex(
    (param) =>
      param.type === AST_NODE_TYPES.ObjectPattern ||
      param.type === AST_NODE_TYPES.ArrayPattern ||
      (param.type === AST_NODE_TYPES.AssignmentPattern && param.left.type !== AST_NODE_TYPES.Identifier),
  );
  return seenPattern !== -1 && fn.params.slice(seenPattern + 1).some((param) => param.type === AST_NODE_TYPES.AssignmentPattern);
}

/**
 * The binding and the core both keep each default. The core's runs again only
 * when the binding's produced `undefined`, which matters only when running it
 * has an effect: a call.
 */
function defaultMayRunTwice(fn: FunctionNode, env: Environment): boolean {
  const calls = (node: TSESTree.Node): boolean =>
    node.type === AST_NODE_TYPES.CallExpression ||
    node.type === AST_NODE_TYPES.TaggedTemplateExpression ||
    (!isFunctionNode(node) && [...childNodes(node, env.sourceCode.visitorKeys)].some(calls));
  return fn.params.some((param) => param.type === AST_NODE_TYPES.AssignmentPattern && calls(param.right));
}

/**
 * The binding forwards a rest parameter with a spread. TypeScript keeps a
 * spread's exact type only for a type parameter, an array or a tuple; it reads
 * `...xs: A & { length: 2 }` as `number[]`, which the core's generic `A` would
 * reject. Without type parameters every rest type is concrete and forwards as is.
 */
function forwardsRestExactly(fn: FunctionNode): boolean {
  const rest = fn.params.at(-1);
  if (!fn.typeParameters || rest?.type !== AST_NODE_TYPES.RestElement || !rest.typeAnnotation) return true;
  const typeParameters = new Set(fn.typeParameters.params.map((param) => param.name.name));
  const exact = (type: TSESTree.TypeNode): boolean => {
    switch (type.type) {
      case AST_NODE_TYPES.TSArrayType:
      case AST_NODE_TYPES.TSTupleType:
        return true;
      case AST_NODE_TYPES.TSTypeOperator:
        return type.operator === "readonly" && type.typeAnnotation !== undefined && exact(type.typeAnnotation);
      case AST_NODE_TYPES.TSTypeReference:
        return (
          type.typeName.type === AST_NODE_TYPES.Identifier &&
          (type.typeArguments
            ? type.typeName.name === "Array" || type.typeName.name === "ReadonlyArray"
            : typeParameters.has(type.typeName.name))
        );
      default:
        return false;
    }
  };
  return exact(rest.typeAnnotation.typeAnnotation);
}

/**
 * A mapped type with an `as` clause, written into the signature itself.
 * TypeScript relates two generic ones only when they come from the same
 * declaration, and the core repeats the signature: its copy would never match
 * the binding's. A named alias is shared by both, so it is fine.
 */
function remapsKeysInline(fn: FunctionNode, env: Environment): boolean {
  let found = false;
  const visit = (node: TSESTree.Node): void => {
    if (found) return;
    if (node.type === AST_NODE_TYPES.TSMappedType && node.nameType) {
      found = true;
      return;
    }
    for (const child of childNodes(node, env.sourceCode.visitorKeys)) visit(child);
  };
  for (const part of [fn.typeParameters, ...fn.params, fn.returnType]) if (part) visit(part);
  return found;
}

/**
 * The split adds a stack frame between the function and its callers, so code
 * that finds a caller by counting frames would find the binding instead.
 */
function inspectsStack(fn: FunctionNode, env: Environment): boolean {
  let found = false;
  const visit = (node: TSESTree.Node): void => {
    if (found) return;
    if (
      (node.type === AST_NODE_TYPES.MemberExpression &&
        !node.computed &&
        node.property.type === AST_NODE_TYPES.Identifier &&
        /^(?:stack|stackTraceLimit|captureStackTrace|prepareStackTrace)$/.test(node.property.name)) ||
      (node.type === AST_NODE_TYPES.Identifier && node.name === "captureStackTrace")
    ) {
      found = true;
      return;
    }
    for (const child of childNodes(node, env.sourceCode.visitorKeys)) visit(child);
  };
  visit(fn.body);
  return found;
}

/**
 * The core runs with the context as `this`, so a function that reads its own
 * `this`, `arguments` or `new.target` would change behavior.
 */
function usesOwnReceiver(fn: FunctionNode, env: Environment): boolean {
  if (fn.type === AST_NODE_TYPES.ArrowFunctionExpression) return false;
  const scope = env.sourceCode.scopeManager?.acquire(fn, true);
  if ((scope?.set.get("arguments")?.references.length ?? 0) > 0) return true;
  let found = false;
  const visit = (node: TSESTree.Node): void => {
    if (found) return;
    if (node !== fn && isFunctionNode(node) && node.type !== AST_NODE_TYPES.ArrowFunctionExpression) return;
    if (node.type === AST_NODE_TYPES.ClassBody) return;
    if (node.type === AST_NODE_TYPES.ThisExpression || (node.type === AST_NODE_TYPES.MetaProperty && node.meta.name === "new")) {
      found = true;
      return;
    }
    for (const child of childNodes(node, env.sourceCode.visitorKeys)) visit(child);
  };
  visit(fn.body);
  return found;
}

/** True when `this` at `node` would be the core's `this`: no function or class body in between rebinds it. */
function readsCoreThis(node: TSESTree.Node, fn: FunctionNode): boolean {
  for (let ancestor = node.parent; ancestor && ancestor !== fn; ancestor = ancestor.parent) {
    if (isFunctionNode(ancestor) && ancestor.type !== AST_NODE_TYPES.ArrowFunctionExpression) return false;
    if (ancestor.type === AST_NODE_TYPES.ClassBody) return false;
  }
  return true;
}

function classify(reference: Reference, site: LiftSite, assumptions: LiftAssumptions): Lifted | LiftBlocker {
  const identifier = reference.identifier;
  if (identifier.type !== AST_NODE_TYPES.Identifier) return "not declared at module level";
  const name = identifier.name;
  if (name === "arguments" || name === "__proto__") return "uses its own this, arguments or new.target";
  const variable = reference.resolved;
  // No definition, or only `declare` statements describing it: a global.
  if (!variable || variable.defs.every(isAmbient)) {
    if (reference.isWrite()) return "writes a constant or import";
    const parent = identifier.parent;
    return {
      name,
      global: true,
      writable: false,
      direct: false,
      callsHost:
        (parent.type === AST_NODE_TYPES.CallExpression && parent.callee === identifier) ||
        (parent.type === AST_NODE_TYPES.TaggedTemplateExpression && parent.tag === identifier),
      guarded: parent.type === AST_NODE_TYPES.UnaryExpression && parent.operator === "typeof",
    };
  }
  if (variable.scope.type !== "module" && variable.scope.type !== "global") return "not declared at module level";
  if (reference.isWrite() && !isReassignable(variable)) return "writes a constant or import";
  // A const enum is inlined by the compiler and cannot be read as a value.
  if (variable.defs.some((def) => def.node.type === AST_NODE_TYPES.TSEnumDeclaration && def.node.const)) return "a const enum";
  return {
    name,
    global: false,
    writable: reference.isWrite(),
    callsHost: false,
    guarded: false,
    direct: !reference.isWrite() && isSettled(variable, site, assumptions),
    widened: widenedType(variable),
  };
}

/**
 * True when `variable` holds its final value whenever the binding can run.
 * Function declarations and namespace imports exist before any code runs, and
 * a binding that does not hoist runs only after its own statement, so a
 * declaration that finishes before that statement has run by then. Named
 * imports are live and may not be initialized yet in an import cycle.
 */
function isSettled(variable: TSESLint.Scope.Variable, site: LiftSite, assumptions: LiftAssumptions): boolean {
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return false;
  const values = variable.defs.filter((def) => def.type !== "Type");
  if (values.length > 0 && values.every((def) => def.type === "FunctionName")) return true;
  const [def, ...others] = values;
  if (!def || others.length > 0) return false;
  switch (def.type) {
    case "ImportBinding":
      return assumptions.importsSettled === true || def.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier;
    case "Variable":
    case "ClassName":
      return !site.hoisted && (def.parent ?? def.node).range[1] <= site.statement.range[0];
    default:
      return false;
  }
}

function widenedType(variable: TSESLint.Scope.Variable): string | undefined {
  const def = variable.defs[0];
  if (variable.defs.length !== 1 || def?.type !== "Variable" || def.parent?.type !== AST_NODE_TYPES.VariableDeclaration) return undefined;
  if (def.parent.kind !== "const" || def.node.type !== AST_NODE_TYPES.VariableDeclarator || def.node.id.typeAnnotation) return undefined;
  let init = def.node.init;
  if (init?.type === AST_NODE_TYPES.UnaryExpression && init.operator === "-") init = init.argument;
  if (init?.type === AST_NODE_TYPES.TemplateLiteral && init.expressions.length === 0) return "string";
  if (init?.type !== AST_NODE_TYPES.Literal) return undefined;
  switch (typeof init.value) {
    case "number":
    case "string":
    case "boolean":
    case "bigint":
      return typeof init.value;
    default:
      return undefined;
  }
}

/**
 * Where TypeScript would widen a literal: an unannotated parameter default or
 * `let`/`var` initializer that is exactly the lifted reference. Returns the node
 * after which to add the annotation, and the annotation.
 */
function wideningSite(identifier: TSESTree.Identifier, lifted: Lifted | undefined): { after: TSESTree.Node; type: string } | undefined {
  if (!lifted?.widened) return undefined;
  const parent = identifier.parent;
  if (
    parent.type === AST_NODE_TYPES.AssignmentPattern &&
    parent.right === identifier &&
    parent.left.type === AST_NODE_TYPES.Identifier &&
    !parent.left.typeAnnotation &&
    parent.parent.type !== AST_NODE_TYPES.Property
  ) {
    return { after: parent.left, type: lifted.widened };
  }
  if (
    parent.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.init === identifier &&
    parent.id.type === AST_NODE_TYPES.Identifier &&
    !parent.id.typeAnnotation &&
    parent.parent.type === AST_NODE_TYPES.VariableDeclaration &&
    parent.parent.kind !== "const"
  ) {
    return { after: parent.id, type: lifted.widened };
  }
  return undefined;
}

function isReassignable(variable: TSESLint.Scope.Variable): boolean {
  return variable.defs.every(
    (def) =>
      def.type === "Variable" && def.parent?.type === AST_NODE_TYPES.VariableDeclaration && def.parent.kind !== "const",
  );
}

/** A name not yet bound in the module, nor used as a global anywhere in it. */
function freshName(base: string, env: Environment, fn: FunctionNode): string {
  const taken = new Set<string>();
  for (let scope = env.sourceCode.scopeManager?.acquire(fn) ?? null; scope; scope = scope.upper) {
    for (const name of scope.set.keys()) taken.add(name);
    for (const reference of scope.through) taken.add(reference.identifier.name);
  }
  for (const scope of env.sourceCode.scopeManager?.scopes ?? []) {
    if (scope.type === "module" || scope.type === "global") for (const name of scope.set.keys()) taken.add(name);
  }
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

/**
 * True for a generated binding: its whole body calls a hermetic function
 * declared in this module with a context, an object literal or a name.
 * Lifting it again would never settle.
 */
export function isBinding(fn: FunctionNode, sourceCode: SourceCode): boolean {
  let expression: TSESTree.Node = fn.body;
  if (fn.body.type === AST_NODE_TYPES.BlockStatement) {
    const [only, ...rest] = fn.body.body;
    if (rest.length > 0 || only?.type !== AST_NODE_TYPES.ReturnStatement || !only.argument) return false;
    expression = only.argument;
  }
  if (expression.type !== AST_NODE_TYPES.CallExpression) return false;
  const callee = expression.callee;
  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    callee.property.name !== "call"
  ) {
    return false;
  }
  const context = expression.arguments[0];
  if (context?.type !== AST_NODE_TYPES.ObjectExpression && context?.type !== AST_NODE_TYPES.Identifier) return false;
  // `(core<T>).call(...)` for a generic core.
  const object = callee.object.type === AST_NODE_TYPES.TSInstantiationExpression ? callee.object.expression : callee.object;
  if (object.type !== AST_NODE_TYPES.Identifier) return false;
  const variable = ASTUtils.findVariable(sourceCode.getScope(object), object);
  const core = variable?.defs[0]?.node;
  return core?.type === AST_NODE_TYPES.FunctionDeclaration && isMarkedHermetic(core, sourceCode);
}

/**
 * Splits the function in place: a binding that keeps the name, signature and
 * export, and calls a hermetic core, declared right after, with a context.
 * The context is an object literal of the lifted values when they are all
 * settled, and otherwise one object, created once, whose getters read each
 * lifted binding when the core does.
 */
export function liftFix(
  fixer: TSESLint.RuleFixer,
  plan: LiftPlan,
  sourceCode: SourceCode,
  typescript: boolean,
): TSESLint.RuleFix[] {
  const { fn } = plan;
  const text = sourceCode.text;
  const base = indentOf(sourceCode, plan.statement);
  const unit = indentUnit(sourceCode, fn);

  const edits: Edit[] = plan.identifiers.map((identifier) => ({
    range: identifier.range,
    text: isShorthandValue(identifier) ? `${identifier.name}: this.${identifier.name}` : `this.${identifier.name}`,
  }));
  if (typescript) {
    for (const identifier of plan.identifiers) {
      const site = wideningSite(identifier, plan.lifted.get(identifier.name));
      if (site) edits.push({ range: [site.after.range[1], site.after.range[1]], text: `: ${site.type}` });
    }
  }
  const raw = (node: TSESTree.Node | undefined | null): string => (node ? text.slice(node.range[0], node.range[1]) : "");

  // The core: same parameters and body, with lifted references read from `this`.
  const lifted = [...plan.lifted.values()];
  const contextType = `this: { ${lifted.map((entry) => `${entry.name}: ${contextMemberType(entry)}`).join("; ")} }`;
  const params = applyEdits(text, parameterSpan(fn, sourceCode), edits);
  const coreParams = typescript ? withThisParameter(params, contextType) : params;
  const head = `${fn.async ? "async " : ""}function${fn.generator ? "*" : ""} ${plan.coreName}`;
  const signature = `${raw(fn.typeParameters)}(${coreParams})${raw(fn.returnType)}`;
  let body: string;
  if (fn.body.type === AST_NODE_TYPES.BlockStatement) {
    const { at, text: directive } = directiveInsertion(fn.body, sourceCode);
    body = applyEdits(text, fn.body.range, [...edits, { range: [at, at], text: directive }]);
  } else {
    // Only arrows have expression bodies.
    const arrow = fn as TSESTree.ArrowFunctionExpression;
    body = `{\n${base}${unit}"use hermetic";\n${base}${unit}return ${expressionBody(arrow, fn.body, sourceCode, edits)};\n${base}}`;
  }
  // Comments between the parts copied above, such as one before `=>`, go before the core's body.
  const copied: (readonly [number, number])[] = [parameterSpan(fn, sourceCode)];
  for (const part of [fn.typeParameters, fn.returnType]) if (part) copied.push(part.range);
  copied.push(fn.body.type === AST_NODE_TYPES.BlockStatement ? fn.body.range : [arrowToken(fn as TSESTree.ArrowFunctionExpression, sourceCode).range[1], fn.range[1]]);
  const notes = renderComments(looseComments(fn, copied, sourceCode), sourceCode, base);
  const core = `${head}${signature} ${notes}${body}`;

  // The binding: same name, parameters and return type; forwards to the core.
  const forwarded: string[] = [];
  const reserved = new Set([...plan.lifted.keys(), ...fn.params.flatMap((param) => (param.type === AST_NODE_TYPES.Identifier ? [param.name] : []))]);
  const bindingParams = fn.params.map((param, index) => {
    let generated = `arg${index}`;
    while (reserved.has(generated)) generated = `_${generated}`;
    reserved.add(generated);
    switch (param.type) {
      case AST_NODE_TYPES.Identifier:
        forwarded.push(param.name);
        return raw(param);
      case AST_NODE_TYPES.AssignmentPattern: {
        // Keeping the default keeps its inferred type and the function's length; it runs once either way.
        if (param.left.type === AST_NODE_TYPES.Identifier) {
          forwarded.push(param.left.name);
          return raw(param);
        }
        forwarded.push(generated);
        return `${generated}${raw(param.left.typeAnnotation)} = ${raw(param.right)}`;
      }
      case AST_NODE_TYPES.RestElement: {
        const name = param.argument.type === AST_NODE_TYPES.Identifier ? param.argument.name : generated;
        forwarded.push(`...${name}`);
        return `...${name}${raw(param.typeAnnotation)}`;
      }
      default: {
        forwarded.push(generated);
        const pattern = param as TSESTree.ObjectPattern | TSESTree.ArrayPattern;
        return `${generated}${pattern.optional && typescript ? "?" : ""}${raw(pattern.typeAnnotation)}`;
      }
    }
  });
  const typeArguments = fn.typeParameters?.params.map((param) => param.name.name) ?? [];
  const callee = typeArguments.length > 0 ? `(${plan.coreName}<${typeArguments.join(", ")}>)` : plan.coreName;
  const context = plan.contextName ?? `{ ${lifted.map((entry) => entry.name).join(", ")} }`;
  const call = `${callee}.call(${[context, ...forwarded].join(", ")})`;
  const bindingSignature = `${raw(fn.typeParameters)}(${layoutParameters(bindingParams, fn, sourceCode)})${raw(fn.returnType)}`;
  const binding =
    fn.type === AST_NODE_TYPES.ArrowFunctionExpression
      ? `${bindingSignature} => ${call}`
      : `function${fn.type === AST_NODE_TYPES.FunctionDeclaration ? ` ${fn.id?.name ?? ""}` : ""}${bindingSignature} {\n${base}${unit}return ${call};\n${base}}`;

  // The shared context comes straight after the binding: nothing can call the binding in between.
  const declarations = [core];
  if (plan.contextName) {
    const members = lifted.flatMap((entry) => contextMembers(entry, typescript)).map((line) => `${base}${unit}${line}`);
    declarations.unshift([`const ${plan.contextName} = {`, ...members, `${base}};`].join("\n"));
  }
  const at = declarationSite(plan.statement, sourceCode);
  return [
    fixer.replaceText(fn, binding),
    fixer.insertTextAfterRange([at, at], declarations.map((declaration) => `\n\n${base}${declaration}`).join("")),
  ];
}

/**
 * Where the context and core go: after the binding's statement and any
 * comments that close on its last line, so a trailing comment stays with the
 * binding. When code shares that line, they go right after the statement:
 * nothing may run between the binding and its context.
 */
function declarationSite(statement: TSESTree.Node, sourceCode: SourceCode): number {
  const line = statement.loc.end.line;
  let end = statement.range[1];
  let next = sourceCode.getTokenAfter(statement, { includeComments: true });
  while (next && isComment(next) && next.loc.start.line === line && next.loc.end.line === line) {
    end = next.range[1];
    next = sourceCode.getTokenAfter(next, { includeComments: true });
  }
  if (next && next.loc.start.line === line) return statement.range[1];
  const lineBreak = new RegExp(LINE_BREAK.source, "g");
  lineBreak.lastIndex = end;
  return lineBreak.exec(sourceCode.text)?.index ?? sourceCode.text.length;
}

function isComment(token: TSESTree.Token): token is TSESTree.Comment {
  return token.type === AST_TOKEN_TYPES.Line || token.type === AST_TOKEN_TYPES.Block;
}

/**
 * The binding's parameters, laid out like the original list: one per line
 * when the original put its first parameter on a line of its own, with a
 * trailing comma only if it had one.
 */
function layoutParameters(params: readonly string[], fn: FunctionNode, sourceCode: SourceCode): string {
  const [start, end] = parameterSpan(fn, sourceCode);
  const span = sourceCode.text.slice(start, end);
  const first = fn.params[0];
  if (!first || !LINE_BREAK.test(/^\s*/.exec(span)?.[0] ?? "")) return params.join(", ");
  const indent = indentOf(sourceCode, first);
  const closing = /[^\S\r\n]*$/.exec(span)?.[0] ?? "";
  const trailing = /,\s*$/.test(span) ? "," : "";
  return `\n${params.map((param, index) => `${indent}${param}${index < params.length - 1 ? "," : trailing}`).join("\n")}\n${closing}`;
}

/** Adds the context parameter in front of the others, following their layout. */
function withThisParameter(params: string, contextType: string): string {
  if (params.trim() === "") return contextType;
  const leading = /^\s*/.exec(params)?.[0] ?? "";
  return LINE_BREAK.test(leading) ? `${leading}${contextType},${params}` : `${contextType}, ${params.slice(leading.length)}`;
}

/**
 * An expression body as the core returns it: everything after `=>`, with its
 * parentheses and comments. A comment that ends a line would let automatic
 * semicolon insertion end the return early, so that text is parenthesized.
 */
function expressionBody(
  fn: TSESTree.ArrowFunctionExpression,
  body: TSESTree.Expression,
  sourceCode: SourceCode,
  edits: readonly Edit[],
): string {
  const start = arrowToken(fn, sourceCode).range[1];
  const expression = applyEdits(sourceCode.text, [start, fn.range[1]], edits).trimStart();
  const first = sourceCode.getFirstToken(body);
  const lead = sourceCode.text.slice(start, first ? first.range[0] : body.range[0]).trim();
  return /\/\/|\r|\n|\u2028|\u2029/.test(lead) ? `(${expression}\n)` : expression;
}

function contextMemberType(entry: Lifted): string {
  return entry.guarded ? `typeof ${entry.name} | undefined` : `typeof ${entry.name}`;
}

function contextMembers(entry: Lifted, typescript: boolean): string[] {
  const { name } = entry;
  let value = entry.callsHost ? `${name}.bind(globalThis)` : name;
  if (entry.guarded) value = `typeof ${name} === "undefined" ? undefined : ${value}`;
  const members = [`get ${name}()${typescript ? `: ${contextMemberType(entry)}` : ""} { return ${value}; },`];
  if (entry.writable) {
    const param = name === "value" ? "next" : "value";
    members.push(`set ${name}(${param}${typescript ? `: typeof ${name}` : ""}) { ${name} = ${param}; },`);
  }
  return members;
}

function isShorthandValue(identifier: TSESTree.Identifier): boolean {
  let node: TSESTree.Node = identifier;
  if (node.parent?.type === AST_NODE_TYPES.AssignmentPattern && node.parent.left === node) node = node.parent;
  const parent = node.parent;
  return parent?.type === AST_NODE_TYPES.Property && parent.shorthand && parent.value === node;
}

function indentOf(sourceCode: SourceCode, node: TSESTree.Node): string {
  return /^\s*/.exec(sourceCode.lines[node.loc.start.line - 1] ?? "")?.[0] ?? "";
}

/** The file's indentation step, read from the function's own body, or two spaces. */
function indentUnit(sourceCode: SourceCode, fn: FunctionNode): string {
  if (fn.body.type === AST_NODE_TYPES.BlockStatement) {
    const first = fn.body.body[0];
    if (first && first.loc.start.line !== fn.body.loc.start.line) {
      const outer = indentOf(sourceCode, fn);
      const inner = indentOf(sourceCode, first);
      if (inner.startsWith(outer) && inner.length > outer.length) return inner.slice(outer.length);
    }
  }
  return "  ";
}
