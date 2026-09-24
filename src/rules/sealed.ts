import path from "node:path";
import { fileURLToPath } from "node:url";
import { AST_NODE_TYPES, ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { loadGround } from "../ground/bootstrap.ts";
import { DEFAULT_GROUND, type Ground, hasDeniedMembers, isDenied } from "../ground/ground.ts";
import { type FunctionNode, functionName, isMarkedHermetic, staticKey } from "../marking.ts";

type Reference = TSESLint.Scope.Reference;
type Variable = TSESLint.Scope.Variable;
type Definition = TSESLint.Scope.Definition;

export interface SealedOptions {
  /**
   * `"allow"` (default) permits type-only references that escape the
   * function, since types are erased. `"structural-only"` reports escaping
   * references to declared types (imports, module-level interfaces and
   * aliases), so the function can move to another file unchanged. Lib and
   * other global types stay allowed.
   */
  types?: "allow" | "structural-only";
  /**
   * Path to a ground bootstrap module, absolute or relative to ESLint's
   * working directory. Without it, the default ground applies.
   */
  ground?: string;
  /**
   * `"best-effort"` (default) reports denied member paths where they are
   * statically visible. `"forbid"` also reports any use of a ground object
   * with denied members that could hand it elsewhere, such as `const m = Math`
   * or `f(Math)`, so denied paths cannot be reached through an alias.
   */
  aliasing?: "best-effort" | "forbid";
}

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

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/bombadil-labs/ts-isolated/blob/main/docs/rules/${name}.md`,
);

// Annotated because the rule lints ground bootstraps with itself, so it refers to its own value.
export const sealed: TSESLint.RuleModule<MessageIds, [SealedOptions]> & { name: string } = createRule<
  [SealedOptions],
  MessageIds
>({
  name: "sealed",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require hermetic functions to touch the world only through their arguments, `this`, and the ground",
    },
    schema: [
      {
        type: "object",
        properties: {
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
            description: "Whether ground objects with denied members may be used other than by static member access.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ types: "allow", aliasing: "best-effort" }],
    messages: {
      freeVariable:
        "'{{name}}' is a free variable in hermetic function '{{fn}}'. Pass it through 'this' or an argument.",
      shadowedGround:
        "'{{name}}' refers to a binding declared outside hermetic function '{{fn}}', not the ground global. Pass it through 'this' or an argument.",
      groundWrite:
        "Hermetic function '{{fn}}' assigns to the ground global '{{name}}'. The ground can be read, not reassigned.",
      deniedPath:
        "'{{path}}' is denied by the ground in hermetic function '{{fn}}'. Pass it through 'this' or an argument.",
      aliasedGround:
        "'{{path}}' has denied members, and hermetic function '{{fn}}' hands it on here, where they could be reached. Pass what you need through 'this' or an argument.",
      typeReference:
        "Type reference '{{name}}' escapes hermetic function '{{fn}}'. With types: \"structural-only\", write the type structurally.",
      lexicalThis:
        "'this' in hermetic arrow function '{{fn}}' is lexical, so it reaches the enclosing scope. Use a non-arrow function to receive 'this'.",
      lexicalNewTarget:
        "'new.target' in hermetic arrow function '{{fn}}' is lexical, so it reaches the enclosing scope. Use a non-arrow function.",
      superReference:
        "'super' in hermetic function '{{fn}}' reaches the enclosing home object. Pass the behavior through 'this' or an argument.",
      importMeta:
        "'import.meta' in hermetic function '{{fn}}' reaches the enclosing module. Pass the value through 'this' or an argument.",
      dynamicImport:
        "Dynamic import() in hermetic function '{{fn}}' loads code through ambient authority. Pass the module through 'this' or an argument.",
      jsx: "JSX in hermetic function '{{fn}}' compiles to a call to the JSX factory, which is a free variable. Pass an element factory through 'this' or an argument.",
    },
  },
  create(context, [options]) {
    const sourceCode = context.sourceCode;
    const ground: Ground =
      options.ground === undefined ? DEFAULT_GROUND : loadGround(resolveGroundPath(options.ground, context.cwd), sealed);
    const structuralOnly = options.types === "structural-only";
    const forbidAliasing = options.aliasing === "forbid";

    /** Marked functions and their display names, recorded on entry so nested nodes can find them. */
    const marked = new Map<TSESTree.Node, string>();
    /** Nested marked functions share escaping references; each node is reported once, for the innermost. */
    const reported = new Set<TSESTree.Node>();
    /** Marked functions currently being traversed. When zero, no node can escape one. */
    let open = 0;

    function report(node: TSESTree.Node, messageId: MessageIds, data: Record<string, string>): void {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId, data });
    }

    function checkReferences(fn: FunctionNode, fnName: string): void {
      const scope = sourceCode.scopeManager?.acquire(fn);
      if (!scope) return;
      for (const reference of scope.through) {
        const identifier = reference.identifier;
        const data = { name: identifier.name, fn: fnName };
        if (isTypeOnly(reference, fn)) {
          if (structuralOnly && isDeclared(reference.resolved)) report(identifier, "typeReference", data);
          continue;
        }
        if (isOwnName(reference, fn)) continue;
        if (!ground.names.has(identifier.name)) {
          report(identifier, "freeVariable", data);
        } else if (isShadowed(reference.resolved)) {
          report(identifier, "shadowedGround", data);
        } else if (reference.isWrite()) {
          report(identifier, "groundWrite", data);
        } else {
          checkGroundAccess(identifier, fnName);
        }
      }
    }

    /**
     * Follows the static member chain rooted at a ground name, such as
     * `Math.random` or `Math["random"]`, and reports denied paths. Destructuring
     * continues the chain. Anything else ends it: best-effort mode accepts the
     * alias, forbid mode reports it when denied members remain beneath it.
     */
    function checkGroundAccess(identifier: TSESTree.Node & { name: string }, fnName: string): void {
      const segments = [identifier.name];
      let node: TSESTree.Node = identifier;
      for (;;) {
        if (isDenied(ground, segments)) {
          report(node, "deniedPath", { path: segments.join("."), fn: fnName });
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
      if (!hasDeniedMembers(ground, segments)) return;
      const pattern = destructuringPattern(node);
      if (pattern) {
        checkPattern(pattern, segments, fnName);
      } else if (forbidAliasing && !isNonAliasingUse(node)) {
        report(node, "aliasedGround", { path: segments.join("."), fn: fnName });
      }
    }

    function checkPattern(pattern: TSESTree.ObjectPattern, segments: readonly string[], fnName: string): void {
      for (const property of pattern.properties) {
        const key = property.type === AST_NODE_TYPES.Property ? propertyKey(property) : undefined;
        if (property.type === AST_NODE_TYPES.RestElement || key === undefined) {
          // A rest element or dynamic key can pick up denied members.
          if (forbidAliasing) report(property, "aliasedGround", { path: segments.join("."), fn: fnName });
          continue;
        }
        const path = [...segments, key];
        if (isDenied(ground, path)) {
          report(property, "deniedPath", { path: path.join("."), fn: fnName });
          continue;
        }
        if (!hasDeniedMembers(ground, path)) continue;
        const target = property.value.type === AST_NODE_TYPES.AssignmentPattern ? property.value.left : property.value;
        if (target.type === AST_NODE_TYPES.ObjectPattern) checkPattern(target, path, fnName);
        else if (forbidAliasing) report(property, "aliasedGround", { path: path.join("."), fn: fnName });
      }
    }

    /**
     * The innermost marked function that a lexically bound `this`,
     * `new.target` or `super` escapes. The binding comes from the nearest
     * boundary; marked functions crossed before reaching it are escaped. For
     * `super`, the boundary method itself is escaped too, because its home
     * object lies outside it.
     */
    function escapedFunction(node: TSESTree.Node, boundaryEscapes: boolean): TSESTree.Node | undefined {
      let child: TSESTree.Node = node;
      for (let ancestor = node.parent; ancestor; child = ancestor, ancestor = ancestor.parent) {
        if (isThisBoundary(ancestor, child)) {
          return boundaryEscapes && marked.has(ancestor) ? ancestor : undefined;
        }
        if (marked.has(ancestor)) return ancestor;
      }
      return undefined;
    }

    function innermostMarked(node: TSESTree.Node): TSESTree.Node | undefined {
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (marked.has(ancestor)) return ancestor;
      }
      return undefined;
    }

    function reportEscape(node: TSESTree.Node, fn: TSESTree.Node | undefined, messageId: MessageIds): void {
      if (fn) report(node, messageId, { fn: marked.get(fn) ?? "<anonymous>" });
    }

    return {
      ":function"(node: FunctionNode) {
        if (!isMarkedHermetic(node, sourceCode)) return;
        marked.set(node, functionName(node));
        open++;
      },
      // Inner functions exit first, so nested escapes are attributed to the innermost marked function.
      ":function:exit"(node: FunctionNode) {
        const fnName = marked.get(node);
        if (fnName === undefined) return;
        open--;
        checkReferences(node, fnName);
      },
      ThisExpression(node) {
        if (open > 0) reportEscape(node, escapedFunction(node, false), "lexicalThis");
      },
      Super(node) {
        if (open > 0) reportEscape(node, escapedFunction(node, true), "superReference");
      },
      MetaProperty(node) {
        if (open === 0) return;
        if (node.meta.name === "import") reportEscape(node, innermostMarked(node), "importMeta");
        else if (node.meta.name === "new") reportEscape(node, escapedFunction(node, false), "lexicalNewTarget");
      },
      ImportExpression(node) {
        if (open > 0) reportEscape(node, innermostMarked(node), "dynamicImport");
      },
      "JSXElement, JSXFragment"(node: TSESTree.JSXElement | TSESTree.JSXFragment) {
        if (open === 0) return;
        // Report the root of each JSX tree once.
        for (let ancestor: TSESTree.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor.type === AST_NODE_TYPES.JSXElement || ancestor.type === AST_NODE_TYPES.JSXFragment) return;
          if (marked.has(ancestor)) {
            reportEscape(node, ancestor, "jsx");
            return;
          }
        }
      },
    };
  },
});

function resolveGroundPath(ground: string, cwd: string): string {
  return ground.startsWith("file:") ? fileURLToPath(ground) : path.resolve(cwd, ground);
}

/**
 * True when a reference is erased at runtime: a type reference, or any
 * reference inside a type annotation, including `typeof x` in a type position.
 */
function isTypeOnly(reference: Reference, fn: FunctionNode): boolean {
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

function isAmbient(def: Definition): boolean {
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
