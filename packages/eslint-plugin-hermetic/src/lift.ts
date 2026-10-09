import { AST_NODE_TYPES, AST_TOKEN_TYPES, ASTUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { applyEdits, arrowToken, childNodes, codeLineStarts, type Edit, LINE_BREAK, looseComments, parameterSpan, renderComments } from "./ast.ts";
import { type Analysis, isAmbient, isThisBoundary, isTypeOnly, type MessageIds, type Problem } from "./analysis.ts";
import { type ClassNode, directiveInsertion, type FunctionNode, isFunctionNode, isMarkedHermetic, isMethod, staticKey } from "./marking.ts";

type Reference = TSESLint.Scope.Reference;
type SourceCode = Readonly<TSESLint.SourceCode>;

/** Problems a lift can resolve: references to module-level names and globals. */
const LIFTABLE: ReadonlySet<MessageIds> = new Set(["freeVariable"]);

/**
 * The functions and constructors ECMAScript puts on the global object. Called
 * without `new`, each ignores its receiver, so the core calls one as
 * `this.Number(x)`. Any other global the function calls without a receiver,
 * such as `fetch`, may look at its `this`, so the core calls it without one
 * too, as `(0, this.fetch)(url)`.
 */
const ECMASCRIPT_FUNCTIONS: ReadonlySet<string> = new Set([
  "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "Error", "escape", "eval", "EvalError",
  "FinalizationRegistry", "Float16Array", "Float32Array", "Float64Array", "Function", "Int16Array", "Int32Array",
  "Int8Array", "isFinite", "isNaN", "Iterator", "Map", "Number", "Object", "parseFloat", "parseInt", "Promise", "Proxy",
  "RangeError", "ReferenceError", "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol", "SyntaxError", "TypeError",
  "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "unescape", "URIError", "WeakMap", "WeakRef", "WeakSet",
]);

/** A name the lift moves into the function's context. */
interface Lifted {
  readonly name: string;
  readonly global: boolean;
  /** Written by the function, so the context needs a setter. */
  writable: boolean;
  /** A global read under `typeof`, which must not throw when the global does not exist. */
  guarded: boolean;
  /**
   * Always initialized and never reassigned whenever the function can run, so
   * the wrapper can pass the value itself instead of a getter.
   */
  direct: boolean;
  /**
   * For a `const` holding a primitive literal, the type TypeScript widens it to
   * in a mutable declaration: `number` for `const BASE = 2`. A `typeof`
   * annotation would keep the literal `2`, so unannotated mutable declarations
   * in the core get this type spelled out.
   */
  readonly widened?: string;
  /** A method's own class, by the name it has inside its body: always initialized when a method of it runs. */
  readonly ownClass?: boolean;
}

export interface LiftPlan {
  readonly fn: FunctionNode;
  readonly coreName: string;
  /** The top-level statement that holds the function, so the core can follow it. */
  readonly statement: TSESTree.Node;
  readonly lifted: ReadonlyMap<string, Lifted>;
  readonly identifiers: readonly TSESTree.Identifier[];
  /**
   * The shared context the wrapper passes, declared once right after it, when
   * some lifted name must be read through a getter. Undefined when every
   * value can be passed directly, in a fresh object literal.
   */
  readonly contextName?: string;
  /** For a method, how its object reaches the core. */
  readonly method?: MethodPlan;
}

/**
 * A method's lift. The core's `this` is its context, as for a function, so the
 * wrapper passes its object as the core's first argument, `self`, and its
 * `arguments` object next when the method reads it.
 */
export interface MethodPlan {
  readonly member: TSESTree.MethodDefinition | TSESTree.Property;
  readonly kind: "method" | "get" | "set";
  readonly selfName: string;
  readonly argumentsName?: string;
  /** With TypeScript, the type of `self`. */
  readonly selfType?: string;
  /**
   * For a class's instance method in TypeScript: a type parameter that stands
   * for the polymorphic `this`, as the class's own type parameters follow it,
   * and the type arguments the wrapper passes for them.
   */
  readonly selfParameter?: { readonly name: string; readonly declarations: readonly string[]; readonly arguments: readonly string[] };
  /** The method's `this` parameter, which `self` replaces in the core. */
  readonly thisParameter?: TSESTree.Identifier;
  /** Every `this` that is the method's own, which reads `self` in the core. */
  readonly thisExpressions: readonly TSESTree.ThisExpression[];
  /** Every read of the method's own `arguments`. */
  readonly argumentReads: readonly TSESTree.Identifier[];
  /** Every `this` type that is the method's own, which reads the `Self` type parameter in the core. */
  readonly thisTypes: readonly TSESTree.TSThisType[];
}

/** Why a function was not lifted: the first check it failed. */
export type LiftBlocker =
  | "structural-only types"
  | "a class field"
  | "a decorated method"
  | "its object's type has no name"
  | "a parameter typed by its object"
  | "arguments in sloppy mode"
  | "the this type"
  | "a type parameter shadows its class's"
  | "reads a private or protected member"
  | "may read a protected member it inherits"
  | "narrows by a lifted key"
  | "a method its statement may call before its context exists"
  | "a class expression's own name"
  | "new.target in a method"
  | "a private name"
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
  | "a direct eval"
  | "another escape";

/**
 * Decides whether `fn` can be split into a hermetic core and a wrapper without
 * changing behavior, and what moves into the context. Returns undefined when a
 * person should decide; `tryLift` says why.
 */
export function planLift(
  fn: FunctionNode,
  problems: readonly Problem[],
  analysis: Analysis,
  assumptions: LiftAssumptions = {},
  taken?: Set<string>,
): LiftPlan | undefined {
  const result = tryLift(fn, problems, analysis, assumptions, taken);
  return typeof result === "string" ? undefined : result;
}

/** What `tryLift` may assume beyond what the lift does. */
export interface LiftAssumptions {
  /**
   * Imported names are initialized before any function that reads them
   * runs, and do not change while it runs. An import cycle breaks the first
   * and an exported `let` the second, so the lift assumes it only when
   * `prefer-hermetic`'s `importsSettled` option says so.
   */
  readonly importsSettled?: boolean;
}

/**
 * The lift's plan for `fn`, or the reason it has none. `taken` holds the names
 * other lifts in the module have chosen, and gets the names this one chooses:
 * two methods can share a name, and their cores must not.
 */
export function tryLift(
  fn: FunctionNode,
  problems: readonly Problem[],
  analysis: Analysis,
  assumptions: LiftAssumptions = {},
  taken?: Set<string>,
): LiftPlan | LiftBlocker {
  if (analysis.structuralOnly) return "structural-only types";
  const site = isMethod(fn) ? methodSite(fn, analysis) : liftSite(fn);
  if (typeof site === "string") return site;
  // A method keeps its `this` and `arguments`: the wrapper passes them to the core.
  if (site.method ? readsNewTarget(fn, analysis) : usesOwnReceiver(fn, analysis)) {
    return site.method ? "new.target in a method" : "uses its own this, arguments or new.target";
  }
  if (suppressesTypeErrors(fn, analysis)) return "suppresses type errors";
  if (defaultReadsPattern(fn)) return "a default reads a destructured parameter";
  if (defaultMayRunTwice(fn, analysis)) return "a default calls a function";
  if (!forwardsRestExactly(fn)) return "a generic rest parameter";
  if (remapsKeysInline(fn, analysis)) return "an inline key-remapped mapped type";
  if (inspectsStack(fn, analysis)) return "reads the stack";

  const references: Reference[] = [];
  for (const problem of problems) {
    if (!problem.reference || !LIFTABLE.has(problem.messageId)) return PROBLEM_BLOCKERS[problem.messageId] ?? "another escape";
    references.push(problem.reference);
  }
  // Once the body moves into the core, a declaration's calls to itself must go through the wrapper, which keeps its name.
  const scope = analysis.sourceCode.scopeManager?.acquire(fn);
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
      existing.guarded ||= entry.guarded;
      existing.direct &&= entry.direct;
    } else {
      lifted.set(entry.name, entry);
    }
    identifiers.push(reference.identifier as TSESTree.Identifier);
  }
  if (analysis.typescript && narrowsByLiftedKey(identifiers, analysis)) return "narrows by a lifted key";
  const direct = [...lifted.values()].every((entry) => entry.direct);
  // A function declaration can run before any statement of its module, a shared context's included.
  if (!direct && site.hoisted) return "a declaration that reads unsettled names";
  if (site.method) {
    // The context is declared after the statement that holds the method.
    if (!direct && site.method.runsEarly) return "a method its statement may call before its context exists";
    // A shared context, and the core's type for its context, name the class from outside it, which only a declaration's name can.
    const ownClass = [...lifted.values()].some((entry) => entry.ownClass);
    if (ownClass && (analysis.typescript || !direct) && !readableByOuterName(site.method.holder, analysis)) return "a class expression's own name";
  }
  const coreName = freshName(`${site.name}Hermetic`, analysis, fn, taken);
  const contextName = direct ? undefined : freshName(`${site.name}Context`, analysis, fn, taken);
  return { fn, coreName, statement: site.statement, lifted, identifiers, contextName, ...(site.method && { method: methodPlan(fn, site.method, analysis) }) };
}

interface LiftSite {
  readonly name: string;
  /** The top-level statement that declares the function, which becomes the wrapper. */
  readonly statement: TSESTree.Node;
  /** A function declaration, callable before any statement of its module has run. */
  readonly hoisted: boolean;
  /** For a method, what holds it and what its object is. */
  readonly method?: MethodSite;
}

interface MethodSite {
  readonly member: TSESTree.MethodDefinition | TSESTree.Property;
  /** The class or object literal that holds the method. */
  readonly holder: ClassNode | TSESTree.ObjectExpression;
  /**
   * The statement may call the method before it has finished: a class's static
   * initializers, or a function the class or object is passed to, can.
   */
  readonly runsEarly: boolean;
  readonly selfType?: string;
  readonly selfParameter?: MethodPlan["selfParameter"];
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

/**
 * A method in a class or an object literal that a module-level statement
 * holds. The core gets its object as `self`, so with TypeScript the lift must
 * be able to name its object's type: a class by its name, an object literal by
 * the type its declaration or an `as` gives it, or either by the method's own
 * `this` parameter.
 */
function methodSite(fn: FunctionNode, analysis: Analysis): LiftSite | LiftBlocker {
  const member = fn.parent;
  if (member.type !== AST_NODE_TYPES.MethodDefinition && member.type !== AST_NODE_TYPES.Property) return "a class field";
  if (member.type === AST_NODE_TYPES.MethodDefinition && member.decorators.length > 0) return "a decorated method";
  const holder = member.type === AST_NODE_TYPES.MethodDefinition ? member.parent.parent : member.parent;
  if (holder.type === AST_NODE_TYPES.ObjectPattern) return "not declared at module level";
  let runsEarly = isClassNode(holder) && classRunsCode(holder);
  let statement: TSESTree.Node | undefined;
  for (let node: TSESTree.Node = holder; node.parent; node = node.parent) {
    if (node.parent.type === AST_NODE_TYPES.Program) {
      statement = node;
      break;
    }
    // The core is declared at module level, where a block's names and an outer class's type parameters are out of scope.
    if (opensScope(node.parent)) return "not declared at module level";
    if (!holdsWithoutRunning(node.parent, node)) runsEarly = true;
  }
  if (!statement) return "not declared at module level";
  const scope = analysis.sourceCode.scopeManager?.acquire(fn, true);
  // In sloppy mode `arguments` tracks the parameters of the function it belongs to, which would be the wrapper.
  if (scope && !scope.isStrict && (scope.set.get("arguments")?.references.length ?? 0) > 0) return "arguments in sloppy mode";
  const returns = fn.returnType?.typeAnnotation;
  if (returns?.type === AST_NODE_TYPES.TSTypePredicate && returns.asserts) return "a this parameter or asserts";
  const outerName = isClassNode(holder) && holder.type === AST_NODE_TYPES.ClassDeclaration ? holder.id?.name : declaredName(holder);
  const holderName = outerName ?? (isClassNode(holder) ? holder.id?.name : undefined);
  const prefix = member.kind === "get" ? "Get" : member.kind === "set" ? "Set" : "";
  const label = `${prefix}${identifierWords(keyLabel(member, analysis.sourceCode))}`;
  const name = holderName ? `${holderName}${label}` : label.charAt(0).toLowerCase() + label.slice(1);
  const site = { name: /^[A-Za-z_$]/.test(name) ? name : `_${name}`, statement, hoisted: false };
  if (!analysis.typescript) return { ...site, method: { member, holder, runsEarly } };

  const text = analysis.sourceCode.text;
  const raw = (node: TSESTree.Node): string => text.slice(node.range[0], node.range[1]);
  const thisParameter = thisParameterOf(fn);
  // A parameter without a type can take one from its object: a setter's from its getter, an object method's from the object's type.
  if (fn.params.some((param) => param !== thisParameter && untyped(param)) && (member.kind === "set" || !isClassNode(holder))) {
    return "a parameter typed by its object";
  }
  let selfType: string;
  let selfParameter: MethodPlan["selfParameter"];
  if (thisParameter) {
    if (!thisParameter.typeAnnotation) return "its object's type has no name";
    selfType = raw(thisParameter.typeAnnotation.typeAnnotation);
  } else if (isClassNode(holder)) {
    const typeName = holder.type === AST_NODE_TYPES.ClassDeclaration ? holder.id?.name : plainDeclaration(holder)?.id.name;
    if (!typeName) return "its object's type has no name";
    if (member.type === AST_NODE_TYPES.MethodDefinition && member.static) {
      selfType = `typeof ${typeName}`;
    } else {
      // The polymorphic `this` of a class is a type parameter, so the core declares one, constrained by the class.
      const classParameters = holder.typeParameters?.params ?? [];
      let constraint: string;
      if (holder.type === AST_NODE_TYPES.ClassDeclaration) {
        constraint = classParameters.length > 0 ? `${typeName}<${classParameters.map((param) => param.name.name).join(", ")}>` : typeName;
      } else if (classParameters.length === 0) {
        constraint = `InstanceType<typeof ${typeName}>`;
      } else {
        return "its object's type has no name";
      }
      const own = new Set(classParameters.map((param) => param.name.name));
      if (fn.typeParameters?.params.some((param) => own.has(param.name.name))) return "a type parameter shadows its class's";
      const selfName = freshIdentifier("Self", [holder.id, holder.typeParameters, fn], analysis);
      selfParameter = {
        name: selfName,
        declarations: [
          `${selfName} extends ${constraint}`,
          ...classParameters.map((param) => `${param.name.name}${param.constraint ? ` extends ${raw(param.constraint)}` : ""}`),
        ],
        arguments: ["this", ...own],
      };
      selfType = selfName;
    }
  } else {
    const declared = objectSelfType(holder, fn, member, raw);
    if (!declared) return "its object's type has no name";
    selfType = declared;
  }
  if (!selfParameter && ownThisTypes(fn, analysis).some((type) => !isThisPredicate(type))) return "the this type";
  if (isClassNode(holder) && readsHiddenMember(fn, holder, analysis)) return "reads a private or protected member";
  if (isClassNode(holder) && mayReadInheritedMember(fn, holder, analysis)) return "may read a protected member it inherits";
  return { ...site, method: { member, holder, runsEarly, selfType, ...(selfParameter && { selfParameter }) } };
}

/** What the fix needs to move a method's body into its core. */
function methodPlan(fn: FunctionNode, site: MethodSite, analysis: Analysis): MethodPlan {
  const scope = analysis.sourceCode.scopeManager?.acquire(fn, true);
  const argumentReads = (scope?.set.get("arguments")?.references ?? []).map((reference) => reference.identifier as TSESTree.Identifier);
  const thisParameter = thisParameterOf(fn);
  const member = site.member;
  return {
    member,
    kind: member.kind === "get" || member.kind === "set" ? member.kind : "method",
    selfName: freshIdentifier("self", [fn], analysis),
    ...(argumentReads.length > 0 && { argumentsName: freshIdentifier("args", [fn], analysis) }),
    ...(site.selfType !== undefined && { selfType: site.selfType }),
    ...(site.selfParameter && { selfParameter: site.selfParameter }),
    ...(thisParameter && { thisParameter }),
    thisExpressions: ownThisExpressions(fn, analysis),
    argumentReads,
    // Without a `Self` type parameter, only a `this is T` return type names the object.
    thisTypes: ownThisTypes(fn, analysis).filter((type) => site.selfParameter !== undefined || isThisPredicate(type)),
  };
}

function isClassNode(node: TSESTree.Node): node is ClassNode {
  return node.type === AST_NODE_TYPES.ClassDeclaration || node.type === AST_NODE_TYPES.ClassExpression;
}

function thisParameterOf(fn: FunctionNode): TSESTree.Identifier | undefined {
  const first = fn.params[0];
  return first?.type === AST_NODE_TYPES.Identifier && first.name === "this" ? first : undefined;
}

/**
 * True when `parent` holds `child` without running code that could call a
 * method in it: a declaration, an export, a type assertion, or an object or
 * array literal around it.
 */
function holdsWithoutRunning(parent: TSESTree.Node, child: TSESTree.Node): boolean {
  switch (parent.type) {
    case AST_NODE_TYPES.VariableDeclaration:
    case AST_NODE_TYPES.ExportNamedDeclaration:
    case AST_NODE_TYPES.ExportDefaultDeclaration:
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSSatisfiesExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
    case AST_NODE_TYPES.ArrayExpression:
    case AST_NODE_TYPES.ObjectExpression:
      return true;
    case AST_NODE_TYPES.VariableDeclarator:
      return parent.init === child;
    case AST_NODE_TYPES.Property:
      return parent.value === child && !parent.computed;
    default:
      return false;
  }
}

/** True when defining the class runs code that could call its methods: a static block, a static initializer, a decorator. */
function classRunsCode(cls: ClassNode): boolean {
  if (cls.decorators.length > 0) return true;
  return cls.body.body.some(
    (element) =>
      element.type === AST_NODE_TYPES.StaticBlock ||
      ("decorators" in element && element.decorators.length > 0) ||
      ((element.type === AST_NODE_TYPES.PropertyDefinition || element.type === AST_NODE_TYPES.AccessorProperty) &&
        element.static &&
        element.value !== null &&
        !isInert(element.value)),
  );
}

/** An expression whose evaluation runs no code: literals, names, functions, and literals of those. */
function isInert(node: TSESTree.Node): boolean {
  switch (node.type) {
    case AST_NODE_TYPES.Literal:
    case AST_NODE_TYPES.Identifier:
    case AST_NODE_TYPES.ArrowFunctionExpression:
    case AST_NODE_TYPES.FunctionExpression:
      return true;
    case AST_NODE_TYPES.TemplateLiteral:
      return node.expressions.length === 0;
    case AST_NODE_TYPES.UnaryExpression:
      return node.operator !== "delete" && isInert(node.argument);
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSSatisfiesExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
      return isInert(node.expression);
    case AST_NODE_TYPES.ArrayExpression:
      return node.elements.every((element) => element === null || isInert(element));
    case AST_NODE_TYPES.ObjectExpression:
      return node.properties.every((property) => property.type === AST_NODE_TYPES.Property && !property.computed && isInert(property.value));
    default:
      return false;
  }
}

/** The name a declaration gives the class or object, through any type assertions around it. */
function declaredName(node: TSESTree.Node): string | undefined {
  let child = node;
  let parent = node.parent;
  while (
    parent &&
    (parent.type === AST_NODE_TYPES.TSAsExpression || parent.type === AST_NODE_TYPES.TSSatisfiesExpression || parent.type === AST_NODE_TYPES.TSNonNullExpression)
  ) {
    child = parent;
    parent = parent.parent;
  }
  return parent?.type === AST_NODE_TYPES.VariableDeclarator && parent.init === child && parent.id.type === AST_NODE_TYPES.Identifier
    ? parent.id.name
    : undefined;
}

/**
 * The type of an object literal's methods' `this`: the type its declaration's
 * annotation or an `as` gives it. Without one, `this` is the literal's own
 * type, which the core reads as `typeof` its constant. That type includes the
 * method's, so the method must spell out what it returns, or the two types
 * would depend on each other.
 */
function objectSelfType(
  object: TSESTree.ObjectExpression,
  fn: FunctionNode,
  member: TSESTree.MethodDefinition | TSESTree.Property,
  raw: (node: TSESTree.Node) => string,
): string | undefined {
  const parent = object.parent;
  if (parent.type === AST_NODE_TYPES.TSAsExpression) {
    const type = parent.typeAnnotation;
    const constant = type.type === AST_NODE_TYPES.TSTypeReference && type.typeName.type === AST_NODE_TYPES.Identifier && type.typeName.name === "const";
    return constant ? undefined : raw(thisTypeOf(type));
  }
  const declarator = plainDeclaration(object);
  if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.init === object && parent.id.type === AST_NODE_TYPES.Identifier && parent.id.typeAnnotation) {
    return raw(thisTypeOf(parent.id.typeAnnotation.typeAnnotation));
  }
  if (declarator && (fn.returnType || member.kind === "set")) return `typeof ${declarator.id.name}`;
  return undefined;
}

/** The type an object of type `type` gives its methods' `this`: `T` for a `ThisType<T>`, alone or in an intersection. */
function thisTypeOf(type: TSESTree.TypeNode): TSESTree.TypeNode {
  const marker = (node: TSESTree.TypeNode): TSESTree.TypeNode | undefined =>
    node.type === AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === AST_NODE_TYPES.Identifier &&
    node.typeName.name === "ThisType" &&
    node.typeArguments?.params.length === 1
      ? node.typeArguments.params[0]
      : undefined;
  if (type.type === AST_NODE_TYPES.TSIntersectionType) {
    for (const member of type.types) {
      const marked = marker(member);
      if (marked) return marked;
    }
  }
  return marker(type) ?? type;
}

/** The declarator whose unannotated name holds exactly `node`, so that `typeof` its name is `node`'s type. */
function plainDeclaration(node: TSESTree.Node): (TSESTree.VariableDeclarator & { id: TSESTree.Identifier }) | undefined {
  const parent = node.parent;
  if (parent?.type !== AST_NODE_TYPES.VariableDeclarator || parent.init !== node) return undefined;
  if (parent.id.type !== AST_NODE_TYPES.Identifier || parent.id.typeAnnotation) return undefined;
  return parent as TSESTree.VariableDeclarator & { id: TSESTree.Identifier };
}

/** True for a node whose names, or type parameters, the module scope does not see. */
function opensScope(node: TSESTree.Node): boolean {
  switch (node.type) {
    case AST_NODE_TYPES.BlockStatement:
    case AST_NODE_TYPES.StaticBlock:
    case AST_NODE_TYPES.SwitchStatement:
    case AST_NODE_TYPES.ForStatement:
    case AST_NODE_TYPES.ForInStatement:
    case AST_NODE_TYPES.ForOfStatement:
    case AST_NODE_TYPES.CatchClause:
    case AST_NODE_TYPES.TSModuleBlock:
      return true;
    case AST_NODE_TYPES.ClassDeclaration:
    case AST_NODE_TYPES.ClassExpression:
      return node.typeParameters !== undefined;
    default:
      return false;
  }
}

/** True for the `this` of a `this is T` return type, which names the method's object. */
function isThisPredicate(node: TSESTree.TSThisType): boolean {
  return node.parent.type === AST_NODE_TYPES.TSTypePredicate && node.parent.parameterName === node;
}

function untyped(param: TSESTree.Parameter): boolean {
  switch (param.type) {
    case AST_NODE_TYPES.AssignmentPattern:
      return false;
    case AST_NODE_TYPES.TSParameterProperty:
      return false;
    default:
      return !param.typeAnnotation;
  }
}

/** A member's key as a label for its core's name: `size`, `Hash.symbol`, `Symbol.iterator`. */
function keyLabel(member: TSESTree.MethodDefinition | TSESTree.Property, sourceCode: SourceCode): string {
  const key = member.key;
  if (key.type === AST_NODE_TYPES.PrivateIdentifier) return key.name;
  if (!member.computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
  return staticKey(key) ?? sourceCode.text.slice(key.range[0], key.range[1]);
}

/** `Hash.symbol` as `HashSymbol`: the words of a label, joined into an identifier. */
function identifierWords(label: string): string {
  const words = label.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return joined || "Member";
}

/** `base`, or `_base`, `__base` and so on: the first that no identifier inside `nodes` spells. */
function freshIdentifier(base: string, nodes: readonly (TSESTree.Node | null | undefined)[], analysis: Analysis): string {
  const taken = new Set<string>();
  const visit = (node: TSESTree.Node): void => {
    if (node.type === AST_NODE_TYPES.Identifier) taken.add(node.name);
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child);
  };
  for (const node of nodes) if (node) visit(node);
  let name = base;
  while (taken.has(name)) name = `_${name}`;
  return name;
}

/** Every `this` whose value is the method's own: not inside a nested function, static block or field. */
function ownThisExpressions(fn: FunctionNode, analysis: Analysis): TSESTree.ThisExpression[] {
  const found: TSESTree.ThisExpression[] = [];
  const visit = (node: TSESTree.Node, parent?: TSESTree.Node): void => {
    if (parent && isThisBoundary(parent, node)) return;
    if (node.type === AST_NODE_TYPES.ThisExpression) found.push(node);
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child, node);
  };
  for (const part of [...fn.params, fn.body]) visit(part);
  return found;
}

/** Every `this` type that is the method's own: not inside a nested class, interface or object type. */
function ownThisTypes(fn: FunctionNode, analysis: Analysis): TSESTree.TSThisType[] {
  const found: TSESTree.TSThisType[] = [];
  const visit = (node: TSESTree.Node): void => {
    if (node.type === AST_NODE_TYPES.ClassBody || node.type === AST_NODE_TYPES.TSInterfaceBody || node.type === AST_NODE_TYPES.TSTypeLiteral) return;
    if (node.type === AST_NODE_TYPES.TSThisType) found.push(node);
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child);
  };
  for (const part of [fn.typeParameters, ...fn.params, fn.returnType, fn.body]) if (part) visit(part);
  return found;
}

/** True when `new.target` in the method's body is its own: the core would not see it. */
function readsNewTarget(fn: FunctionNode, analysis: Analysis): boolean {
  let found = false;
  const visit = (node: TSESTree.Node, parent?: TSESTree.Node): void => {
    if (found || (parent && isThisBoundary(parent, node))) return;
    if (node.type === AST_NODE_TYPES.MetaProperty && node.meta.name === "new") found = true;
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child, node);
  };
  for (const part of [...fn.params, fn.body]) visit(part);
  return found;
}

/**
 * True when the method reads a member that its class, or a class it extends
 * in this module, declares `private` or `protected`: TypeScript lets only the
 * classes reach it, and the core is outside them.
 */
function readsHiddenMember(fn: FunctionNode, cls: ClassNode, analysis: Analysis): boolean {
  const hidden = new Set<string>();
  for (const element of classChain(cls, analysis).flatMap((link) => link.body.body)) {
    if ("accessibility" in element && (element.accessibility === "private" || element.accessibility === "protected")) {
      if ("key" in element && !element.computed && element.key.type === AST_NODE_TYPES.Identifier) hidden.add(element.key.name);
    }
    if (element.type === AST_NODE_TYPES.MethodDefinition && element.kind === "constructor") {
      for (const param of element.value.params) {
        if (param.type !== AST_NODE_TYPES.TSParameterProperty || (param.accessibility !== "private" && param.accessibility !== "protected")) continue;
        const target = param.parameter.type === AST_NODE_TYPES.AssignmentPattern ? param.parameter.left : param.parameter;
        if (target.type === AST_NODE_TYPES.Identifier) hidden.add(target.name);
      }
    }
  }
  if (hidden.size === 0) return false;
  return readMembers(fn, analysis).some((name) => hidden.has(name));
}

/**
 * The names of the members the function reads by name, `o.name` or
 * `const { name } = o`, and with `own`, only those of its own object.
 */
function readMembers(fn: FunctionNode, analysis: Analysis, own = false): string[] {
  const names: string[] = [];
  const key = (property: TSESTree.Property): string | undefined =>
    property.computed ? undefined : property.key.type === AST_NODE_TYPES.Identifier ? property.key.name : staticKey(property.key);
  const visit = (node: TSESTree.Node): void => {
    if (node.type === AST_NODE_TYPES.MemberExpression && !node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
      if (!own || node.object.type === AST_NODE_TYPES.ThisExpression) names.push(node.property.name);
    }
    if (node.type === AST_NODE_TYPES.VariableDeclarator && node.id.type === AST_NODE_TYPES.ObjectPattern) {
      if (!own || node.init?.type === AST_NODE_TYPES.ThisExpression) {
        for (const property of node.id.properties) if (property.type === AST_NODE_TYPES.Property) names.push(key(property) ?? "");
      }
    }
    if (!own && node.type === AST_NODE_TYPES.ObjectPattern) {
      for (const property of node.properties) if (property.type === AST_NODE_TYPES.Property) names.push(key(property) ?? "");
    }
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child);
  };
  for (const part of [...fn.params, fn.body]) visit(part);
  return names.filter(Boolean);
}

/**
 * True when the class extends one from another module, and the method reads
 * a member of its object that this module doesn't declare: it may be one the
 * other class declares `protected`. A global class declares none.
 */
function mayReadInheritedMember(fn: FunctionNode, cls: ClassNode, analysis: Analysis): boolean {
  const chain = classChain(cls, analysis);
  const base = chain.at(-1)?.superClass;
  if (!base) return false;
  if (base.type === AST_NODE_TYPES.Identifier) {
    const variable = ASTUtils.findVariable(analysis.sourceCode.getScope(base), base);
    if (!variable || variable.defs.every(isAmbient)) return false;
  }
  const declared = new Set<string>();
  for (const element of chain.flatMap((link) => link.body.body)) {
    if ("key" in element && !element.computed && element.key.type === AST_NODE_TYPES.Identifier) declared.add(element.key.name);
    if (element.type === AST_NODE_TYPES.MethodDefinition && element.kind === "constructor") {
      for (const param of element.value.params) {
        if (param.type !== AST_NODE_TYPES.TSParameterProperty) continue;
        const target = param.parameter.type === AST_NODE_TYPES.AssignmentPattern ? param.parameter.left : param.parameter;
        if (target.type === AST_NODE_TYPES.Identifier) declared.add(target.name);
      }
    }
  }
  return readMembers(fn, analysis, true).some((name) => !declared.has(name));
}

/** The class and the classes it extends, as far as this module declares them. */
function classChain(cls: ClassNode, analysis: Analysis): ClassNode[] {
  const chain: ClassNode[] = [];
  for (let link: ClassNode | undefined = cls; link && !chain.includes(link); ) {
    chain.push(link);
    const superClass: TSESTree.Node | null = link.superClass;
    if (superClass?.type !== AST_NODE_TYPES.Identifier) break;
    const variable = ASTUtils.findVariable(analysis.sourceCode.getScope(superClass), superClass);
    const node = variable?.defs.length === 1 ? variable.defs[0]?.node : undefined;
    link = node && isClassNode(node) ? node : node?.type === AST_NODE_TYPES.VariableDeclarator && node.init && isClassNode(node.init) ? node.init : undefined;
  }
  return chain;
}

/** True when the class can be read by its name from outside it: a declaration whose name the module never reassigns. */
function readableByOuterName(holder: ClassNode | TSESTree.ObjectExpression, analysis: Analysis): boolean {
  if (holder.type !== AST_NODE_TYPES.ClassDeclaration || !holder.id) return false;
  const variable = analysis.sourceCode.scopeManager?.acquire(holder)?.upper?.set.get(holder.id.name);
  return variable !== undefined && variable.references.every((reference) => !reference.isWrite() || reference.init === true);
}

/**
 * True when a lifted name is the key of a member the function reads twice,
 * once in a test: TypeScript narrows `o[KEY]` across a test, but not
 * `o[this.KEY]`, so `o[KEY] && o[KEY]()` would stop type-checking.
 */
function narrowsByLiftedKey(identifiers: readonly TSESTree.Identifier[], analysis: Analysis): boolean {
  const text = analysis.sourceCode.text;
  const accesses = new Map<string, TSESTree.MemberExpression[]>();
  for (const identifier of identifiers) {
    const member = identifier.parent;
    if (member.type !== AST_NODE_TYPES.MemberExpression || !member.computed || member.property !== identifier) continue;
    const key = text.slice(member.range[0], member.range[1]);
    accesses.set(key, [...(accesses.get(key) ?? []), member]);
  }
  const tested = (node: TSESTree.Node): boolean => {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      switch (parent.type) {
        case AST_NODE_TYPES.LogicalExpression:
          if (parent.left === child) return true;
          break;
        case AST_NODE_TYPES.IfStatement:
        case AST_NODE_TYPES.ConditionalExpression:
        case AST_NODE_TYPES.WhileStatement:
        case AST_NODE_TYPES.DoWhileStatement:
        case AST_NODE_TYPES.ForStatement:
          return parent.test === child;
        case AST_NODE_TYPES.UnaryExpression:
        case AST_NODE_TYPES.BinaryExpression:
        case AST_NODE_TYPES.ChainExpression:
        case AST_NODE_TYPES.TSNonNullExpression:
          break;
        default:
          return false;
      }
    }
    return false;
  };
  return [...accesses.values()].some((members) => members.length > 1 && members.some(tested));
}

/** Problems the lift cannot resolve, by the reason they give. */
const PROBLEM_BLOCKERS: Partial<Record<MessageIds, LiftBlocker>> = {
  privateName: "a private name",
  jsx: "JSX",
  lexicalThis: "lexical this or new.target",
  lexicalNewTarget: "lexical this or new.target",
  superReference: "super",
  importMeta: "import.meta or import()",
  dynamicImport: "import.meta or import()",
};

/** `@ts-expect-error` and `@ts-ignore` target lines that move; the author should decide. */
function suppressesTypeErrors(fn: FunctionNode, analysis: Analysis): boolean {
  return analysis.sourceCode
    .getCommentsInside(fn)
    .some((comment) => /@ts-(?:expect-error|ignore|nocheck)\b/.test(comment.value));
}

/**
 * The wrapper keeps each default value, so it may not read a name that only a
 * destructured parameter before it declares: the wrapper forwards that parameter whole.
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
 * The wrapper and the core both keep each default. The core's runs again only
 * when the wrapper's produced `undefined`, which matters only when running it
 * has an effect: a call.
 */
function defaultMayRunTwice(fn: FunctionNode, analysis: Analysis): boolean {
  const calls = (node: TSESTree.Node): boolean =>
    node.type === AST_NODE_TYPES.CallExpression ||
    node.type === AST_NODE_TYPES.TaggedTemplateExpression ||
    (!isFunctionNode(node) && [...childNodes(node, analysis.sourceCode.visitorKeys)].some(calls));
  return fn.params.some((param) => param.type === AST_NODE_TYPES.AssignmentPattern && calls(param.right));
}

/**
 * The wrapper forwards a rest parameter with a spread. TypeScript keeps a
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
 * the wrapper's. A named alias is shared by both, so it is fine.
 */
function remapsKeysInline(fn: FunctionNode, analysis: Analysis): boolean {
  let found = false;
  const visit = (node: TSESTree.Node): void => {
    if (found) return;
    if (node.type === AST_NODE_TYPES.TSMappedType && node.nameType) {
      found = true;
      return;
    }
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child);
  };
  for (const part of [fn.typeParameters, ...fn.params, fn.returnType]) if (part) visit(part);
  return found;
}

/**
 * The split adds a stack frame between the function and its callers, so code
 * that finds a caller by counting frames would find the wrapper instead.
 */
function inspectsStack(fn: FunctionNode, analysis: Analysis): boolean {
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
    for (const child of childNodes(node, analysis.sourceCode.visitorKeys)) visit(child);
  };
  visit(fn.body);
  return found;
}

/**
 * The core runs with the context as `this`, so a function that reads its own
 * `this`, `arguments` or `new.target` would change behavior.
 */
function usesOwnReceiver(fn: FunctionNode, analysis: Analysis): boolean {
  if (fn.type === AST_NODE_TYPES.ArrowFunctionExpression) return false;
  const scope = analysis.sourceCode.scopeManager?.acquire(fn, true);
  if ((scope?.set.get("arguments")?.references.length ?? 0) > 0) return true;
  // Its parameters' defaults, and a nested class's computed keys, read the function's `this` too.
  return readsNewTarget(fn, analysis) || ownThisExpressions(fn, analysis).length > 0;
}

/**
 * True when the core must call `identifier` without a receiver, as the original
 * did: a global other than ECMAScript's own functions, called bare.
 */
function callsWithoutReceiver(identifier: TSESTree.Identifier, entry: Lifted | undefined): boolean {
  return entry?.global === true && isBareCall(identifier) && !ECMASCRIPT_FUNCTIONS.has(identifier.name);
}

/** True when `identifier` is called without a receiver: `f()`, or a tagged template. */
function isBareCall(identifier: TSESTree.Node): boolean {
  const parent = identifier.parent;
  return (
    (parent?.type === AST_NODE_TYPES.CallExpression && parent.callee === identifier) ||
    (parent?.type === AST_NODE_TYPES.TaggedTemplateExpression && parent.tag === identifier)
  );
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
  // A context can't pass these: `this.__proto__` reads its prototype, and a class can't have a `constructor` accessor.
  if (name === "arguments" || name === "__proto__" || name === "constructor") return "uses its own this, arguments or new.target";
  const variable = reference.resolved;
  // No definition, or only `declare` statements describing it: a global.
  if (!variable || variable.defs.every(isAmbient)) {
    if (reference.isWrite()) return "writes a constant or import";
    // A bare call to eval is a direct eval, which sees the caller's scope. Called through `this`, it wouldn't.
    if (name === "eval" && isBareCall(identifier)) return "a direct eval";
    const parent = identifier.parent;
    return {
      name,
      global: true,
      writable: false,
      direct: false,
      guarded: parent.type === AST_NODE_TYPES.UnaryExpression && parent.operator === "typeof",
    };
  }
  // A method's own class, by the name its body sees, is initialized before any of its methods can run, and is constant.
  if (site.method && variable.scope.type === "class" && variable.defs.some((def) => def.node === site.method?.holder)) {
    if (reference.isWrite()) return "writes a constant or import";
    return { name, global: false, writable: false, guarded: false, direct: true, ownClass: true };
  }
  if (variable.scope.type !== "module" && variable.scope.type !== "global") return "not declared at module level";
  if (reference.isWrite() && !isReassignable(variable)) return "writes a constant or import";
  // A const enum is inlined by the compiler and cannot be read as a value.
  if (variable.defs.some((def) => def.node.type === AST_NODE_TYPES.TSEnumDeclaration && def.node.const)) return "a const enum";
  return {
    name,
    global: false,
    writable: reference.isWrite(),
    guarded: false,
    direct: !reference.isWrite() && isSettled(variable, site, assumptions),
    widened: widenedType(variable),
  };
}

/**
 * True when `variable` holds its final value whenever the wrapper can run.
 * Function declarations and namespace imports exist before any code runs, and
 * a wrapper that does not hoist runs only after its own statement, so a
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

/** A name not yet bound in the module, nor used as a global anywhere in it, nor in `chosen`, which gets it. */
function freshName(base: string, analysis: Analysis, fn: FunctionNode, chosen?: Set<string>): string {
  const taken = new Set<string>(chosen);
  for (let scope = analysis.sourceCode.scopeManager?.acquire(fn) ?? null; scope; scope = scope.upper) {
    for (const name of scope.set.keys()) taken.add(name);
    for (const reference of scope.through) taken.add(reference.identifier.name);
  }
  for (const scope of analysis.sourceCode.scopeManager?.scopes ?? []) {
    if (scope.type === "module" || scope.type === "global") for (const name of scope.set.keys()) taken.add(name);
  }
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  chosen?.add(name);
  return name;
}

/**
 * True for an accessor of a shared context the lift wrote: a member of
 * `new (class { … })()`, an anonymous class of nothing but accessors.
 */
export function isContextAccessor(fn: FunctionNode): boolean {
  const member = fn.parent;
  if (member.type !== AST_NODE_TYPES.MethodDefinition || (member.kind !== "get" && member.kind !== "set")) return false;
  const cls = member.parent.parent;
  return (
    cls.type === AST_NODE_TYPES.ClassExpression &&
    !cls.id &&
    !cls.superClass &&
    cls.parent.type === AST_NODE_TYPES.NewExpression &&
    cls.parent.callee === cls &&
    cls.parent.arguments.length === 0 &&
    cls.body.body.every((element) => element.type === AST_NODE_TYPES.MethodDefinition && (element.kind === "get" || element.kind === "set"))
  );
}

function isSetter(fn: FunctionNode): boolean {
  const parent = fn.parent;
  return (parent.type === AST_NODE_TYPES.MethodDefinition || parent.type === AST_NODE_TYPES.Property) && parent.kind === "set";
}

/**
 * True for a generated wrapper: its whole body calls a hermetic function
 * declared in this module with a context, an object literal or a name.
 * Lifting it again would never settle.
 */
export function isWrapper(fn: FunctionNode, sourceCode: SourceCode): boolean {
  let expression: TSESTree.Node = fn.body;
  if (fn.body.type === AST_NODE_TYPES.BlockStatement) {
    const [only, ...rest] = fn.body.body;
    if (rest.length > 0 || !only) return false;
    // A setter's wrapper calls its core without returning.
    if (only.type === AST_NODE_TYPES.ReturnStatement && only.argument) expression = only.argument;
    else if (only.type === AST_NODE_TYPES.ExpressionStatement && isSetter(fn)) expression = only.expression;
    else return false;
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
 * Splits the function in place: a wrapper that keeps the name, signature and
 * export, and calls a hermetic core, declared right after, with a context.
 * The context is an object literal of the lifted values when they are all
 * settled, and otherwise one object, created once, whose getters read each
 * lifted name when the core does. That object is an instance of a class:
 * V8 keeps an object literal with getters in dictionary mode, where reading a
 * property costs several times as much.
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
  const edits = liftedEdits(plan, typescript);
  const raw = (node: TSESTree.Node | undefined | null): string => (node ? text.slice(node.range[0], node.range[1]) : "");

  // The core: same parameters and body, with lifted references read from `this`.
  const params = applyEdits(text, parameterSpan(fn, sourceCode), edits);
  const coreParams = typescript ? withLeadingParameters(params, [contextParameter(plan)]) : params;
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
  const core = `${head}${signature} ${carriedComments(fn, sourceCode, base)}${body}`;

  // The wrapper: same name, parameters and return type; forwards to the core.
  const { params: wrapperParams, forwarded } = wrapperParameters(plan, raw, typescript);
  const typeArguments = fn.typeParameters?.params.map((param) => param.name.name) ?? [];
  const callee = typeArguments.length > 0 ? `(${plan.coreName}<${typeArguments.join(", ")}>)` : plan.coreName;
  const call = `${callee}.call(${[contextArgument(plan), ...forwarded].join(", ")})`;
  const wrapperSignature = `${raw(fn.typeParameters)}(${layoutParameters(wrapperParams, fn, sourceCode)})${raw(fn.returnType)}`;
  const wrapper =
    fn.type === AST_NODE_TYPES.ArrowFunctionExpression
      ? `${wrapperSignature} => ${call}`
      : `function${fn.type === AST_NODE_TYPES.FunctionDeclaration ? ` ${fn.id?.name ?? ""}` : ""}${wrapperSignature} {\n${base}${unit}return ${call};\n${base}}`;

  // The shared context comes straight after the wrapper: nothing can call the wrapper in between.
  const declarations = [contextDeclaration(plan, base, unit, typescript), core].filter((declaration) => declaration !== undefined);
  const at = declarationSite(plan.statement, sourceCode);
  return [
    fixer.replaceText(fn, wrapper),
    fixer.insertTextAfterRange([at, at], declarations.map((declaration) => `\n\n${base}${declaration}`).join("")),
  ];
}

/**
 * Splits every method a statement holds, in one fix: ESLint applies one fix
 * to a range per pass, and the cores of all of them go after the statement.
 * Each method becomes a wrapper that keeps its key, modifiers and signature,
 * apart from `async` and `*`, which only the core needs. The wrapper calls
 * the core with a context, its object, and its `arguments` when the core
 * reads them. In the core the object is `self` and `arguments` is `args`,
 * and with TypeScript a class's polymorphic `this` type is a type parameter,
 * `Self`, that the wrapper passes `this` for.
 */
export function liftMethodsFix(
  fixer: TSESLint.RuleFixer,
  plans: readonly LiftPlan[],
  sourceCode: SourceCode,
  typescript: boolean,
): TSESLint.RuleFix[] {
  const [first] = plans;
  if (!first) return [];
  const base = indentOf(sourceCode, first.statement);
  const fixes: TSESLint.RuleFix[] = [];
  const declarations: string[] = [];
  for (const plan of [...plans].sort((a, b) => a.fn.range[0] - b.fn.range[0])) {
    const split = splitMethod(plan, sourceCode, typescript, base);
    fixes.push(fixer.replaceText(plan.fn, split.wrapper), ...split.removals.map((range) => fixer.removeRange(range)));
    declarations.push(...split.declarations);
  }
  const at = declarationSite(first.statement, sourceCode);
  fixes.push(fixer.insertTextAfterRange([at, at], declarations.map((declaration) => `\n\n${base}${declaration}`).join("")));
  return fixes;
}

function splitMethod(
  plan: LiftPlan,
  sourceCode: SourceCode,
  typescript: boolean,
  base: string,
): { wrapper: string; removals: [number, number][]; declarations: string[] } {
  const { fn } = plan;
  const method = plan.method;
  if (!method) throw new Error("Not a method's plan");
  const text = sourceCode.text;
  const raw = (node: TSESTree.Node | undefined | null): string => (node ? text.slice(node.range[0], node.range[1]) : "");
  const memberIndent = indentOf(sourceCode, method.member);
  const unit = indentUnit(sourceCode, fn);
  // The core sits at the statement's indentation, so its lines lose what the member's add to it.
  const prefix = memberIndent.startsWith(base) ? memberIndent.slice(base.length) : "";
  const span = parameterSpan(fn, sourceCode);

  const edits = liftedEdits(plan, typescript);
  for (const node of method.thisExpressions) edits.push({ range: node.range, text: method.selfName });
  for (const identifier of method.argumentReads) {
    edits.push({ range: identifier.range, text: isShorthandValue(identifier) ? `arguments: ${method.argumentsName}` : `${method.argumentsName}` });
  }
  for (const type of method.thisTypes) {
    if (!isThisPredicate(type)) {
      edits.push({ range: type.range, text: method.selfParameter?.name ?? method.selfName });
      continue;
    }
    // `this is T` becomes `self is Self & (T)`: a parameter's predicate must narrow the parameter's own type.
    edits.push({ range: type.range, text: method.selfName });
    const predicate = type.parent as TSESTree.TSTypePredicate;
    if (predicate.typeAnnotation && method.selfType !== undefined) {
      const [start, end] = predicate.typeAnnotation.typeAnnotation.range;
      edits.push({ range: [start, start], text: `${method.selfType} & (` }, { range: [end, end], text: ")" });
    }
  }
  if (method.thisParameter) {
    // `self` takes the place of the method's `this` parameter.
    const after = sourceCode.getTokenAfter(method.thisParameter);
    const next = after?.value === "," ? sourceCode.getTokenAfter(after, { includeComments: true }) : undefined;
    edits.push({ range: [method.thisParameter.range[0], next ? Math.min(next.range[0], span[1]) : method.thisParameter.range[1]], text: "" });
  }
  const parts = [fn.typeParameters, fn.returnType].filter((part) => part !== undefined);
  const replaced = [...edits];
  for (const at of codeLineStarts(sourceCode, fn, [span, fn.body.range, ...parts.map((part) => part.range)])) {
    if (!prefix || !text.startsWith(prefix, at) || replaced.some(({ range }) => range[0] <= at && at < range[1])) continue;
    edits.push({ range: [at, at + prefix.length], text: "" });
  }
  const dedent = (inserted: string): string => (prefix ? inserted.replace(new RegExp(`(${LINE_BREAK.source})${prefix}`, "g"), "$1") : inserted);

  // The core: the object, then `arguments`, come before the method's own parameters.
  const leading = [
    ...(typescript ? [contextParameter(plan)] : []),
    method.selfType === undefined ? method.selfName : `${method.selfName}: ${method.selfType}`,
    ...(method.argumentsName === undefined ? [] : [typescript ? `${method.argumentsName}: IArguments` : method.argumentsName]),
  ];
  const coreParams = withLeadingParameters(applyEdits(text, span, edits), leading);
  let typeParameters = fn.typeParameters ? applyEdits(text, fn.typeParameters.range, edits) : "";
  if (method.selfParameter) {
    const own = typeParameters.slice(1, -1).trim().replace(/,$/, "");
    typeParameters = `<${[...method.selfParameter.declarations, ...(own ? [own] : [])].join(", ")}>`;
  }
  const returnType = fn.returnType ? applyEdits(text, fn.returnType.range, edits) : "";
  const body = fn.body as TSESTree.BlockStatement;
  const directive = directiveInsertion(body, sourceCode);
  const block = applyEdits(text, body.range, [...edits, { range: [directive.at, directive.at], text: dedent(directive.text) }]);
  const head = `${fn.async ? "async " : ""}function${fn.generator ? "*" : ""} ${plan.coreName}`;
  const core = `${head}${typeParameters}(${coreParams})${returnType} ${carriedComments(fn, sourceCode, base)}${block}`;

  // The wrapper: same parameters and return type; passes its object to the core.
  const { params: wrapperParams, forwarded } = wrapperParameters(plan, raw, typescript);
  const typeArguments = [...(method.selfParameter?.arguments ?? []), ...(fn.typeParameters?.params.map((param) => param.name.name) ?? [])];
  const callee = typeArguments.length > 0 ? `(${plan.coreName}<${typeArguments.join(", ")}>)` : plan.coreName;
  const passed = [contextArgument(plan), "this", ...(method.argumentsName === undefined ? [] : ["arguments"]), ...forwarded];
  const call = `${callee}.call(${passed.join(", ")})`;
  const wrapper = `${raw(fn.typeParameters)}(${layoutParameters(wrapperParams, fn, sourceCode)})${raw(fn.returnType)} {\n${memberIndent}${unit}${method.kind === "set" ? "" : "return "}${call};\n${memberIndent}}`;

  const declarations = [contextDeclaration(plan, base, unit, typescript), core].filter((declaration) => declaration !== undefined);
  return { wrapper, removals: modifierRemovals(plan, sourceCode), declarations };
}

/** The `async` and `*` before a method's key, each with the space after it. */
function modifierRemovals(plan: LiftPlan, sourceCode: SourceCode): [number, number][] {
  const { fn, method } = plan;
  if (!method || (!fn.async && !fn.generator)) return [];
  const key = method.member.key;
  let token = method.member.computed ? sourceCode.getTokenBefore(key, { filter: (candidate) => candidate.value === "[" }) : sourceCode.getFirstToken(key);
  const removals: [number, number][] = [];
  const remove = (modifier: TSESTree.Token): void => {
    const next = sourceCode.getTokenAfter(modifier, { includeComments: true });
    removals.push([modifier.range[0], next ? next.range[0] : modifier.range[1]]);
  };
  if (fn.generator && token) {
    const star = sourceCode.getTokenBefore(token);
    if (star?.value === "*") {
      remove(star);
      token = star;
    }
  }
  if (fn.async && token) {
    const keyword = sourceCode.getTokenBefore(token);
    if (keyword?.value === "async") remove(keyword);
  }
  return removals;
}

/**
 * The edits that make the core read each lifted name from `this`, and, with
 * TypeScript, keep the type of each literal a declaration would widen.
 */
function liftedEdits(plan: LiftPlan, typescript: boolean): Edit[] {
  const edits: Edit[] = plan.identifiers.map((identifier) => ({
    range: identifier.range,
    text: isShorthandValue(identifier)
      ? `${identifier.name}: this.${identifier.name}`
      : callsWithoutReceiver(identifier, plan.lifted.get(identifier.name))
        ? `(0, this.${identifier.name})`
        : `this.${identifier.name}`,
  }));
  if (typescript) {
    for (const identifier of plan.identifiers) {
      const site = wideningSite(identifier, plan.lifted.get(identifier.name));
      if (site) edits.push({ range: [site.after.range[1], site.after.range[1]], text: `: ${site.type}` });
    }
  }
  return edits;
}

/** The core's `this` parameter, which types its context. */
function contextParameter(plan: LiftPlan): string {
  return `this: { ${[...plan.lifted.values()].map((entry) => `${entry.name}: ${contextMemberType(entry)}`).join("; ")} }`;
}

/** What the wrapper passes as the core's `this`: the shared context, or an object literal of the values. */
function contextArgument(plan: LiftPlan): string {
  return plan.contextName ?? `{ ${[...plan.lifted.keys()].join(", ")} }`;
}

/** The shared context's declaration, when the plan has one. */
function contextDeclaration(plan: LiftPlan, base: string, unit: string, typescript: boolean): string | undefined {
  if (!plan.contextName) return undefined;
  const members = [...plan.lifted.values()].flatMap((entry) => contextMembers(entry, typescript)).map((line) => `${base}${unit}${line}`);
  return [`const ${plan.contextName} = new (class {`, ...members, `${base}})();`].join("\n");
}

/** Comments between the parts of the signature the core copies, such as one before `=>`, which go before its body. */
function carriedComments(fn: FunctionNode, sourceCode: SourceCode, indent: string): string {
  const copied: (readonly [number, number])[] = [parameterSpan(fn, sourceCode)];
  for (const part of [fn.typeParameters, fn.returnType]) if (part) copied.push(part.range);
  copied.push(fn.body.type === AST_NODE_TYPES.BlockStatement ? fn.body.range : [arrowToken(fn as TSESTree.ArrowFunctionExpression, sourceCode).range[1], fn.range[1]]);
  return renderComments(looseComments(fn, copied, sourceCode), sourceCode, indent);
}

/**
 * The wrapper's parameters, and what it passes the core for each. A pattern
 * is passed whole, under a generated name, for the core to take apart; a
 * method's `this` parameter stays in its signature and is passed as its object.
 */
function wrapperParameters(
  plan: LiftPlan,
  raw: (node: TSESTree.Node | undefined | null) => string,
  typescript: boolean,
): { params: string[]; forwarded: string[] } {
  const { fn } = plan;
  const forwarded: string[] = [];
  const reserved = new Set([...plan.lifted.keys(), ...fn.params.flatMap((param) => (param.type === AST_NODE_TYPES.Identifier ? [param.name] : []))]);
  const params = fn.params.map((param, index) => {
    let generated = `arg${index}`;
    while (reserved.has(generated)) generated = `_${generated}`;
    reserved.add(generated);
    switch (param.type) {
      case AST_NODE_TYPES.Identifier:
        if (param !== plan.method?.thisParameter) forwarded.push(param.name);
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
  return { params, forwarded };
}

/**
 * Where the context and core go: after the wrapper's statement and any
 * comments that close on its last line, so a trailing comment stays with the
 * wrapper. When code shares that line, they go right after the statement:
 * nothing may run between the wrapper and its context.
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
 * The wrapper's parameters, laid out like the original list: one per line
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

/** Adds parameters in front of the others, following their layout. */
function withLeadingParameters(params: string, added: readonly string[]): string {
  if (params.trim() === "") return added.join(", ");
  const leading = /^\s*/.exec(params)?.[0] ?? "";
  return LINE_BREAK.test(leading) ? `${leading}${added.join(`,${leading}`)},${params}` : `${added.join(", ")}, ${params.slice(leading.length)}`;
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
  const value = entry.guarded ? `typeof ${name} === "undefined" ? undefined : ${name}` : name;
  const members = [`get ${name}()${typescript ? `: ${contextMemberType(entry)}` : ""} { return ${value}; }`];
  if (entry.writable) {
    const param = name === "value" ? "next" : "value";
    members.push(`set ${name}(${param}${typescript ? `: typeof ${name}` : ""}) { ${name} = ${param}; }`);
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
