import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";
import { childNodes } from "./ast.ts";
import { IMMUTABLE_GLOBALS } from "@bombadil/hermetic";
import type { FunctionNode } from "./marking.ts";

type Reference = TSESLint.Scope.Reference;
type Variable = TSESLint.Scope.Variable;
type Definition = TSESLint.Scope.Definition;

export type MessageIds =
  | "dynamicImport"
  | "freeVariable"
  | "importMeta"
  | "jsx"
  | "lexicalNewTarget"
  | "lexicalThis"
  | "method"
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

/** What "hermetic" means for a lint run. */
export interface Environment {
  readonly sourceCode: Readonly<TSESLint.SourceCode>;
  readonly structuralOnly: boolean;
}

/** Options shared by every rule, settable per rule or once in `settings.hermetic`. */
export interface HermeticSettings {
  types?: "allow" | "structural-only";
}

export const SETTINGS_SCHEMA: Record<keyof HermeticSettings, JSONSchema4> = {
  types: {
    type: "string",
    enum: ["allow", "structural-only"],
    description: "How to treat type-only references that escape a hermetic function.",
  },
};

/**
 * Resolves the environment for one file: rule options win over
 * `settings.hermetic`, which wins over the defaults.
 */
export function createEnvironment(
  context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>,
  options: HermeticSettings,
): Environment {
  const settings = readSettings(context.settings);
  return {
    sourceCode: context.sourceCode,
    structuralOnly: (options.types ?? settings.types) === "structural-only",
  };
}

/** Settings from before 0.3.0, when hermetic functions could read a list of allowed globals. */
const REMOVED_SETTINGS = ["ground", "aliasing"];

function readSettings(settings: Record<string, unknown>): HermeticSettings {
  const value = settings.hermetic;
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) throw new TypeError("settings.hermetic must be an object.");
  const found = value as Record<string, unknown>;
  for (const name of REMOVED_SETTINGS) {
    if (name in found) {
      throw new TypeError(
        `settings.hermetic.${name} was removed in 0.3.0: hermetic functions read no globals, so there is nothing to allow. Pass what they need through 'this' or an argument.`,
      );
    }
  }
  const { types } = found;
  if (types !== undefined && types !== "allow" && types !== "structural-only") {
    throw new TypeError('settings.hermetic.types must be "allow" or "structural-only".');
  }
  return { types };
}

/**
 * Every way `fn` reaches outside itself: references that escape it, and the
 * syntactic escapes scope analysis cannot see.
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
    // undefined, NaN and Infinity read like keywords, unless a declaration outside the function takes the name.
    if (IMMUTABLE_GLOBALS.includes(identifier.name) && !isShadowed(reference.resolved)) continue;
    problems.push({ node: identifier, messageId: "freeVariable", data, reference });
  }
  return problems;
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
 * True when a global's name resolves to a real binding in an enclosing scope
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
