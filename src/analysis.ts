import path from "node:path";
import { fileURLToPath } from "node:url";
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";
import { childNodes } from "./ast.ts";
import { loadGround } from "./ground/bootstrap.ts";
import { DEFAULT_GROUND, type Ground, hasDeniedMembers, isDenied } from "./ground/ground.ts";
import { type FunctionNode, staticKey } from "./marking.ts";

type Reference = TSESLint.Scope.Reference;
type Variable = TSESLint.Scope.Variable;
type Definition = TSESLint.Scope.Definition;

export type MessageIds =
  | "aliasedGround"
  | "deniedPath"
  | "dynamicImport"
  | "freeVariable"
  | "groundWrite"
  | "importMeta"
  | "jsx"
  | "lexicalNewTarget"
  | "lexicalThis"
  | "shadowedGround"
  | "superReference"
  | "typeReference";

/** One way a function reaches outside itself. */
export interface Problem {
  readonly node: TSESTree.Node;
  readonly messageId: MessageIds;
  readonly data: Record<string, string>;
  /** The escaping reference, for problems that come from one. */
  readonly reference?: Reference;
}

/** What "hermetic" means for a lint run: the ground and the strictness options. */
export interface Environment {
  readonly sourceCode: Readonly<TSESLint.SourceCode>;
  readonly ground: Ground;
  readonly structuralOnly: boolean;
  readonly forbidAliasing: boolean;
}

/** Options shared by every rule, settable per rule or once in `settings.hermetic`. */
export interface HermeticSettings {
  types?: "allow" | "structural-only";
  ground?: string;
  aliasing?: "best-effort" | "forbid";
}

export const SETTINGS_SCHEMA: Record<keyof HermeticSettings, JSONSchema4> = {
  types: {
    type: "string",
    enum: ["allow", "structural-only"],
    description: "How to treat type-only references that escape a hermetic function.",
  },
  ground: {
    type: "string",
    description: "Path to a ground bootstrap module, absolute or relative to ESLint's working directory.",
  },
  aliasing: {
    type: "string",
    enum: ["best-effort", "forbid"],
    description: "Whether ground objects with denied members may be handed elsewhere.",
  },
};

/**
 * Resolves the environment for one file: rule options win over
 * `settings.hermetic`, which wins over the defaults. `selfLint` is the sealed
 * rule, which a ground bootstrap must pass before it runs.
 */
export function createEnvironment(
  context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>,
  options: HermeticSettings,
  selfLint: TSESLint.AnyRuleModule,
): Environment {
  const settings = readSettings(context.settings);
  const ground = options.ground ?? settings.ground;
  return {
    sourceCode: context.sourceCode,
    ground: ground === undefined ? DEFAULT_GROUND : loadGround(resolveGroundPath(ground, context.cwd), selfLint),
    structuralOnly: (options.types ?? settings.types) === "structural-only",
    forbidAliasing: (options.aliasing ?? settings.aliasing) === "forbid",
  };
}

function readSettings(settings: Record<string, unknown>): HermeticSettings {
  const value = settings.hermetic;
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) throw new TypeError("settings.hermetic must be an object.");
  const { types, ground, aliasing } = value as Record<string, unknown>;
  if (types !== undefined && types !== "allow" && types !== "structural-only") {
    throw new TypeError('settings.hermetic.types must be "allow" or "structural-only".');
  }
  if (ground !== undefined && typeof ground !== "string") throw new TypeError("settings.hermetic.ground must be a path.");
  if (aliasing !== undefined && aliasing !== "best-effort" && aliasing !== "forbid") {
    throw new TypeError('settings.hermetic.aliasing must be "best-effort" or "forbid".');
  }
  return { types, ground, aliasing };
}

function resolveGroundPath(ground: string, cwd: string): string {
  return ground.startsWith("file:") ? fileURLToPath(ground) : path.resolve(cwd, ground);
}

/**
 * Every way `fn` reaches outside itself: references that escape it and are not
 * in the ground, and the syntactic escapes scope analysis cannot see.
 */
export function analyze(fn: FunctionNode, name: string, env: Environment): Problem[] {
  return [...referenceProblems(fn, name, env), ...escapeProblems(fn, name, env)];
}

function referenceProblems(fn: FunctionNode, fnName: string, env: Environment): Problem[] {
  const problems: Problem[] = [];
  const scope = env.sourceCode.scopeManager?.acquire(fn);
  if (!scope) return problems;
  for (const reference of scope.through) {
    const identifier = reference.identifier;
    const data = { name: identifier.name, fn: fnName };
    if (isTypeOnly(reference, fn)) {
      if (env.structuralOnly && isDeclared(reference.resolved)) {
        problems.push({ node: identifier, messageId: "typeReference", data, reference });
      }
      continue;
    }
    if (isOwnName(reference, fn)) continue;
    if (!env.ground.names.has(identifier.name)) {
      problems.push({ node: identifier, messageId: "freeVariable", data, reference });
    } else if (isShadowed(reference.resolved)) {
      problems.push({ node: identifier, messageId: "shadowedGround", data, reference });
    } else if (reference.isWrite()) {
      problems.push({ node: identifier, messageId: "groundWrite", data, reference });
    } else {
      groundAccessProblems(reference, fnName, env, problems);
    }
  }
  return problems;
}

/**
 * Follows the static member chain rooted at a ground name, such as
 * `Math.random` or `Math["random"]`, and reports denied paths. Destructuring
 * continues the chain. Anything else ends it: best-effort mode accepts the
 * alias, forbid mode reports it when denied members remain beneath it.
 */
function groundAccessProblems(reference: Reference, fnName: string, env: Environment, problems: Problem[]): void {
  const segments = [reference.identifier.name];
  let node: TSESTree.Node = reference.identifier;
  for (;;) {
    if (isDenied(env.ground, segments)) {
      problems.push({ node, messageId: "deniedPath", data: { path: segments.join("."), fn: fnName }, reference });
      return;
    }
    node = skipTransparentWrappers(node);
    const parent = node.parent;
    if (parent?.type !== AST_NODE_TYPES.MemberExpression || parent.object !== node) break;
    const key = memberKey(parent);
    if (key === undefined) break;
    segments.push(key);
    node = parent;
  }
  if (!hasDeniedMembers(env.ground, segments)) return;
  const pattern = destructuringPattern(node);
  if (pattern) {
    patternProblems(pattern, segments, fnName, env, problems, reference);
  } else if (env.forbidAliasing && !isNonAliasingUse(node)) {
    problems.push({ node, messageId: "aliasedGround", data: { path: segments.join("."), fn: fnName }, reference });
  }
}

function patternProblems(
  pattern: TSESTree.ObjectPattern,
  segments: readonly string[],
  fnName: string,
  env: Environment,
  problems: Problem[],
  reference: Reference,
): void {
  for (const property of pattern.properties) {
    const key = property.type === AST_NODE_TYPES.Property ? propertyKey(property) : undefined;
    if (property.type === AST_NODE_TYPES.RestElement || key === undefined) {
      // A rest element or dynamic key can pick up denied members.
      if (env.forbidAliasing) {
        const data = { path: segments.join("."), fn: fnName };
        problems.push({ node: property, messageId: "aliasedGround", data, reference });
      }
      continue;
    }
    const path = [...segments, key];
    if (isDenied(env.ground, path)) {
      problems.push({ node: property, messageId: "deniedPath", data: { path: path.join("."), fn: fnName }, reference });
      continue;
    }
    if (!hasDeniedMembers(env.ground, path)) continue;
    const target = property.value.type === AST_NODE_TYPES.AssignmentPattern ? property.value.left : property.value;
    if (target.type === AST_NODE_TYPES.ObjectPattern) {
      patternProblems(target, path, fnName, env, problems, reference);
    } else if (env.forbidAliasing) {
      problems.push({ node: property, messageId: "aliasedGround", data: { path: path.join("."), fn: fnName }, reference });
    }
  }
}

/** `this`, `super`, `new.target`, `import.meta`, `import()` and JSX that reach outside `fn`. */
function escapeProblems(fn: FunctionNode, fnName: string, env: Environment): Problem[] {
  const problems: Problem[] = [];
  const data = { fn: fnName };
  const visit = (node: TSESTree.Node): void => {
    switch (node.type) {
      case AST_NODE_TYPES.ThisExpression:
        if (bindsOutside(node, fn, false)) problems.push({ node, messageId: "lexicalThis", data });
        break;
      case AST_NODE_TYPES.Super:
        if (bindsOutside(node, fn, true)) problems.push({ node, messageId: "superReference", data });
        break;
      case AST_NODE_TYPES.MetaProperty:
        if (node.meta.name === "import") problems.push({ node, messageId: "importMeta", data });
        else if (node.meta.name === "new" && bindsOutside(node, fn, false)) {
          problems.push({ node, messageId: "lexicalNewTarget", data });
        }
        break;
      case AST_NODE_TYPES.ImportExpression:
        problems.push({ node, messageId: "dynamicImport", data });
        break;
      case AST_NODE_TYPES.JSXElement:
      case AST_NODE_TYPES.JSXFragment:
        if (isJsxRoot(node, fn)) problems.push({ node, messageId: "jsx", data });
        break;
      default:
        break;
    }
    for (const child of childNodes(node, env.sourceCode.visitorKeys)) visit(child);
  };
  visit(fn);
  return problems;
}

/**
 * True when the `this`, `new.target` or `super` at `node` is bound outside
 * `fn`. A boundary inside `fn` binds it there. Reaching `fn` itself escapes if
 * `fn` is an arrow; for `super`, it also escapes a method, whose home object
 * lies outside it.
 */
function bindsOutside(node: TSESTree.Node, fn: FunctionNode, superLike: boolean): boolean {
  let child: TSESTree.Node = node;
  for (let ancestor = node.parent; ancestor; child = ancestor, ancestor = ancestor.parent) {
    if (ancestor === fn) return fn.type === AST_NODE_TYPES.ArrowFunctionExpression || superLike;
    if (isThisBoundary(ancestor, child)) return false;
  }
  return false;
}

/** A JSX element or fragment with no JSX ancestor inside `fn`, so each tree is reported once. */
function isJsxRoot(node: TSESTree.Node, fn: FunctionNode): boolean {
  for (let ancestor = node.parent; ancestor && ancestor !== fn; ancestor = ancestor.parent) {
    if (ancestor.type === AST_NODE_TYPES.JSXElement || ancestor.type === AST_NODE_TYPES.JSXFragment) return false;
  }
  return true;
}

/**
 * TypeScript nodes that carry runtime semantics. Every other `TS*` node is a
 * type context, where references are erased: `typeof x` in a type position
 * produces a value reference in the scope manager but never runs.
 */
const RUNTIME_TS_NODES: ReadonlySet<string> = new Set([
  AST_NODE_TYPES.TSAsExpression,
  AST_NODE_TYPES.TSEnumBody,
  AST_NODE_TYPES.TSEnumDeclaration,
  AST_NODE_TYPES.TSEnumMember,
  AST_NODE_TYPES.TSExportAssignment,
  AST_NODE_TYPES.TSExternalModuleReference,
  AST_NODE_TYPES.TSImportEqualsDeclaration,
  AST_NODE_TYPES.TSInstantiationExpression,
  AST_NODE_TYPES.TSModuleBlock,
  AST_NODE_TYPES.TSModuleDeclaration,
  AST_NODE_TYPES.TSNonNullExpression,
  AST_NODE_TYPES.TSParameterProperty,
  AST_NODE_TYPES.TSSatisfiesExpression,
  AST_NODE_TYPES.TSTypeAssertion,
]);

/**
 * True when a reference is erased at runtime: a type reference, or any
 * reference inside a type annotation, including `typeof x` in a type position.
 */
export function isTypeOnly(reference: Reference, fn: FunctionNode): boolean {
  if (reference.isTypeReference && !reference.isValueReference) return true;
  for (let node: TSESTree.Node | undefined = reference.identifier.parent; node && node !== fn; node = node.parent) {
    if (node.type.startsWith("TS") && !RUNTIME_TS_NODES.has(node.type)) return true;
  }
  return false;
}

/**
 * A function declaration may call itself by name. The toString round trip
 * turns the declaration into a named function expression, which binds its own
 * name, so the reference survives relocation. That holds only while the
 * binding is never reassigned.
 */
function isOwnName(reference: Reference, fn: FunctionNode): boolean {
  const variable = reference.resolved;
  return (
    fn.type === AST_NODE_TYPES.FunctionDeclaration &&
    variable !== null &&
    variable.defs.some((def) => def.node === fn) &&
    variable.references.every((ref) => !ref.isWrite())
  );
}

/** True when the variable has a declaration in source: an import, a local, a type. */
function isDeclared(variable: Variable | null): boolean {
  return variable !== null && variable.defs.length > 0;
}

/**
 * True when a ground name resolves to a real binding in an enclosing scope
 * rather than the global. Ambient `declare` statements only describe globals.
 */
function isShadowed(variable: Variable | null): boolean {
  return variable !== null && variable.defs.length > 0 && !variable.defs.every(isAmbient);
}

/** True for a `declare` statement, or anything inside `declare global` or `declare module`. */
export function isAmbient(def: Definition): boolean {
  for (let node: TSESTree.Node | undefined = def.node; node; node = node.parent) {
    if ("declare" in node && node.declare === true) return true;
  }
  return false;
}

/** Nodes that set their own `this`, `new.target` and `super` for `child`. */
function isThisBoundary(ancestor: TSESTree.Node, child: TSESTree.Node): boolean {
  switch (ancestor.type) {
    case AST_NODE_TYPES.FunctionDeclaration:
    case AST_NODE_TYPES.FunctionExpression:
    case AST_NODE_TYPES.StaticBlock:
      return true;
    case AST_NODE_TYPES.PropertyDefinition:
    case AST_NODE_TYPES.AccessorProperty:
      // Field initializers see the instance; computed keys see the outer scope.
      return ancestor.value === child;
    default:
      return false;
  }
}

/** Climbs through wrappers that leave the runtime value unchanged: `x!`, `x as T`, `x satisfies T`, `<T>x`, `a?.b`. */
function skipTransparentWrappers(node: TSESTree.Node): TSESTree.Node {
  let current = node;
  for (let parent = current.parent; parent; parent = current.parent) {
    switch (parent.type) {
      case AST_NODE_TYPES.TSNonNullExpression:
      case AST_NODE_TYPES.TSAsExpression:
      case AST_NODE_TYPES.TSSatisfiesExpression:
      case AST_NODE_TYPES.TSTypeAssertion:
      case AST_NODE_TYPES.ChainExpression:
        if (parent.expression !== current) return current;
        current = parent;
        break;
      default:
        return current;
    }
  }
  return current;
}

function propertyKey(property: TSESTree.Property): string | undefined {
  if (!property.computed && property.key.type === AST_NODE_TYPES.Identifier) return property.key.name;
  return staticKey(property.key);
}

function memberKey(member: TSESTree.MemberExpression): string | undefined {
  if (member.computed) return staticKey(member.property);
  return member.property.type === AST_NODE_TYPES.Identifier ? member.property.name : undefined;
}

/** The object pattern that destructures `node`, as in `const { random } = Math`. */
function destructuringPattern(node: TSESTree.Node): TSESTree.ObjectPattern | undefined {
  const parent = node.parent;
  switch (parent?.type) {
    case AST_NODE_TYPES.VariableDeclarator:
      return parent.init === node && parent.id.type === AST_NODE_TYPES.ObjectPattern ? parent.id : undefined;
    case AST_NODE_TYPES.AssignmentExpression:
    case AST_NODE_TYPES.AssignmentPattern:
      return parent.right === node && parent.left.type === AST_NODE_TYPES.ObjectPattern ? parent.left : undefined;
    default:
      return undefined;
  }
}

/**
 * Uses that read a ground object without handing it anywhere: `typeof`,
 * calling or constructing it, comparisons, and `instanceof` or `in` tests.
 */
function isNonAliasingUse(node: TSESTree.Node): boolean {
  const parent = node.parent;
  switch (parent?.type) {
    case AST_NODE_TYPES.UnaryExpression:
      return parent.operator === "typeof";
    case AST_NODE_TYPES.CallExpression:
    case AST_NODE_TYPES.NewExpression:
      return parent.callee === node;
    case AST_NODE_TYPES.TaggedTemplateExpression:
      return parent.tag === node;
    case AST_NODE_TYPES.BinaryExpression:
      return NON_ALIASING_OPERATORS.has(parent.operator) || (parent.operator === "in" && parent.right === node);
    default:
      return false;
  }
}

const NON_ALIASING_OPERATORS: ReadonlySet<string> = new Set(["===", "!==", "==", "!=", "instanceof"]);
