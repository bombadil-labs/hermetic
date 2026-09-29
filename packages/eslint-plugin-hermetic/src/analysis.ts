import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";
import { childNodes } from "./ast.ts";
import { IMMUTABLE_GLOBALS } from "@bombadil/hermetic";
import type { ClassNode, FunctionNode } from "./marking.ts";

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
  | "privateName"
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

/** What "hermetic" means for a lint run: the file, and the options that decide it. */
export interface Analysis {
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
 * Resolves the analysis for one file: rule options win over
 * `settings.hermetic`, which wins over the defaults.
 */
export function createAnalysis(
  context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>,
  options: HermeticSettings,
): Analysis {
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
 * syntactic escapes scope analysis cannot see. A method's `this` is its
 * object, one of its inputs, as a function's `this` is. A class is analyzed
 * whole: its heritage, fields, static blocks and methods.
 */
export function analyze(fn: FunctionNode | ClassNode, name: string, analysis: Analysis): Problem[] {
  return [...referenceProblems(fn, name, analysis), ...escapeProblems(fn, name, analysis)];
}

function referenceProblems(fn: FunctionNode | ClassNode, fnName: string, analysis: Analysis): Problem[] {
  const problems: Problem[] = [];
  const scope = analysis.sourceCode.scopeManager?.acquire(fn);
  if (!scope) return problems;
  for (const reference of scope.through) {
    const identifier = reference.identifier;
    const data = { name: identifier.name, fn: fnName };
    if (isTypeOnly(reference, fn)) {
      if (analysis.structuralOnly && isDeclared(reference.resolved)) {
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

/** `this`, `super`, `new.target`, private names, `import.meta`, `import()` and JSX that reach outside `fn`. */
function escapeProblems(fn: FunctionNode | ClassNode, fnName: string, analysis: Analysis): Problem[] {
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
      case AST_NODE_TYPES.PrivateIdentifier:
        if (isPrivateReference(node) && declaredOutside(node, fn)) {
          problems.push({ node, messageId: "privateName", data: { name: `#${node.name}`, fn: fnName } });
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
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child);
  };
  visit(fn);
  return problems;
}

/**
 * True when the `this`, `new.target` or `super` at `node` is bound outside
 * `fn`. A boundary inside `fn` binds it there. Reaching `fn` itself escapes if
 * `fn` is an arrow, or a class, whose own heritage and computed keys see the
 * scope around it; for `super`, it also escapes a method, whose home object
 * lies outside it.
 */
function bindsOutside(node: TSESTree.Node, fn: FunctionNode | ClassNode, superLike: boolean): boolean {
  let child: TSESTree.Node = node;
  for (let ancestor = node.parent; ancestor; child = ancestor, ancestor = ancestor.parent) {
    if (ancestor === fn) return fn.type === AST_NODE_TYPES.ArrowFunctionExpression || isClass(fn) || superLike;
    if (isThisBoundary(ancestor, child)) return false;
  }
  return false;
}

function isClass(node: TSESTree.Node): node is ClassNode {
  return node.type === AST_NODE_TYPES.ClassDeclaration || node.type === AST_NODE_TYPES.ClassExpression;
}

/** A private name that is used, as in `this.#count` or `#count in value`, rather than declared as a member's key. */
function isPrivateReference(node: TSESTree.PrivateIdentifier): boolean {
  const parent = node.parent;
  return (
    (parent.type === AST_NODE_TYPES.MemberExpression && parent.property === node) ||
    (parent.type === AST_NODE_TYPES.BinaryExpression && parent.left === node)
  );
}

/**
 * True when the class that declares the private name at `node` lies outside
 * `fn`, so `fn` works only inside that class. The nearest class body that
 * declares the name is the one it refers to. A heritage clause sees the
 * private names around its class, not the class's own.
 */
function declaredOutside(node: TSESTree.PrivateIdentifier, fn: FunctionNode | ClassNode): boolean {
  for (let ancestor: TSESTree.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === AST_NODE_TYPES.ClassBody && declaresPrivate(ancestor, node.name)) return false;
    if (ancestor === fn) return true;
  }
  return false;
}

function declaresPrivate(body: TSESTree.ClassBody, name: string): boolean {
  return body.body.some(
    (member) =>
      "key" in member && member.key.type === AST_NODE_TYPES.PrivateIdentifier && member.key.name === name,
  );
}

/** A JSX element or fragment with no JSX ancestor inside `fn`, so each tree is reported once. */
function isJsxRoot(node: TSESTree.Node, fn: FunctionNode | ClassNode): boolean {
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
export function isTypeOnly(reference: Reference, fn: FunctionNode | ClassNode): boolean {
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
 * name is never reassigned.
 */
function isOwnName(reference: Reference, fn: FunctionNode | ClassNode): boolean {
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
 * True when a global's name resolves to a declaration in an enclosing scope
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
