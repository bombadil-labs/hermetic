import { parse as acornParse } from "acorn";
import type * as ES from "estree";
import { createGround, DEFAULT_GROUND, type Ground, type GroundConfig } from "./ground.ts";

/**
 * Parses JavaScript into an ESTree program whose nodes carry `start` and `end`
 * offsets, as acorn's do, and throws on a syntax error. A method's source
 * doesn't include its class, so the parser must accept private names that are
 * never declared, as acorn does with `checkPrivateFields: false`.
 */
export type Parse = (source: string, sourceType: "module" | "script") => unknown;

/** What `checkHermetic` receives as `this`: a parser, and the globals a function may read. */
export interface CheckContext {
  readonly parse: Parse;
  readonly ground: Ground;
}

export type ProblemKind =
  /** A name the function reads that is neither declared inside it nor an allowed global. */
  | "freeVariable"
  /** An assignment to an allowed global. */
  | "groundWrite"
  /** A denied member of an allowed global, such as `Math.random`. */
  | "deniedPath"
  /** `this` in an arrow function, which comes from the enclosing scope. */
  | "lexicalThis"
  /** `new.target` in an arrow function, which comes from the enclosing scope. */
  | "lexicalNewTarget"
  /** `super` that refers to a class or object outside the function. */
  | "superReference"
  | "importMeta"
  | "dynamicImport"
  /** A `with` statement, which can turn any name inside it into a member of its object. */
  | "withStatement"
  /** The source doesn't parse; `name` holds the parser's message. */
  | "syntax"
  /** The source parses, but not as a single function, method or accessor. */
  | "notAFunction";

export interface Problem {
  readonly kind: ProblemKind;
  /** The name, dotted path or construct involved, or the parser's message for `syntax`. */
  readonly name: string;
  /**
   * Offsets into the checked source. A `syntax` problem marks where parsing
   * stopped, when the parser says; `notAFunction` spans the whole source.
   */
  readonly start: number;
  readonly end: number;
}

export interface CheckResult {
  /**
   * `"function"` for a function or arrow function, `"method"` for a method or
   * accessor, and undefined when the source is not a single function.
   */
  readonly form: "function" | "method" | undefined;
  /** Its body starts with a `"use hermetic"` directive. */
  readonly marked: boolean;
  /** It reads nothing but its inputs and the allowed globals. */
  readonly hermetic: boolean;
  readonly problems: readonly Problem[];
}

/**
 * Checks one function's source, as `Function.prototype.toString` returns it,
 * using acorn as the parser. `ground` is what a ground bootstrap returns; only
 * the keys of its `allow` matter here. Without one, the default allowed
 * globals apply.
 */
export function check(fn: string | ((...args: never[]) => unknown), ground?: GroundConfig): CheckResult {
  const source = typeof fn === "function" ? Function.prototype.toString.call(fn) : fn;
  const context: CheckContext = {
    parse: parseWithAcorn,
    ground: ground ? createGround(Object.keys(ground.allow), ground.deny) : DEFAULT_GROUND,
  };
  return checkHermetic.call(context, source);
}

const parseWithAcorn: Parse = (source, sourceType) =>
  acornParse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false });

/**
 * Checks one function's source for everything it reads besides its inputs and
 * the allowed globals.
 *
 * It is itself hermetic: the parser and the allowed globals arrive through
 * `this`, and every helper is nested inside it, so its source is complete on
 * its own and can be evaluated and bound in any runtime.
 */
export function checkHermetic(this: CheckContext, source: string): CheckResult {
  "use hermetic";
  const parse = this.parse;
  const ground = this.ground;

  interface Scope {
    readonly parent: Scope | undefined;
    readonly names: Set<string>;
  }
  interface Context {
    /** Where names are looked up, and where `let`, `const`, `class` and function declarations go. */
    readonly scope: Scope;
    /** Where `var` declarations go: the nearest function body or static block. */
    readonly varScope: Scope;
    /** `this` and `new.target` belong to a function inside the checked one. */
    readonly ownThis: boolean;
    /** `super` refers to a class or object inside the checked function. */
    readonly ownSuper: boolean;
  }
  type FunctionFound = ES.FunctionExpression | ES.ArrowFunctionExpression;
  type Positioned = { readonly start: number; readonly end: number };

  const problems: Problem[] = [];
  const references: { name: string; scope: Scope; node: ES.Node; write: boolean }[] = [];
  const accesses: { root: string; scope: Scope; path: readonly string[]; node: ES.Node }[] = [];
  let offset = 0;

  function report(kind: ProblemKind, name: string, node: ES.Node): void {
    const { start, end } = node as unknown as Positioned;
    problems.push({ kind, name, start: start - offset, end: end - offset });
  }

  function failure(kind: ProblemKind, name: string, start: number, end: number): CheckResult {
    return { form: undefined, marked: false, hermetic: false, problems: [{ kind, name, start, end }] };
  }

  function scopeIn(parent: Scope | undefined): Scope {
    return { parent, names: new Set() };
  }

  function resolves(name: string, from: Scope | undefined): boolean {
    for (let scope = from; scope; scope = scope.parent) if (scope.names.has(name)) return true;
    return false;
  }

  function isNode(value: unknown): value is ES.Node {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
  }

  // A function or arrow function parses as what a method returns, where `super`
  // and `new.target` in an arrow function parse, to be reported. A method or
  // accessor parses as the only member of a class body, or failing that of an
  // object literal, which also takes methods named `constructor`. Each wrapper
  // closes on a new line, so a trailing line comment can't swallow it, and
  // anything but exactly one function in its place is refused, so the source
  // can't smuggle in more.
  function soleExpression(program: ES.Program): ES.Expression | undefined {
    const statement = program.body.length === 1 ? program.body[0] : undefined;
    return statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  }

  function classMethodIn(program: ES.Program): ES.FunctionExpression | undefined {
    const expression = soleExpression(program);
    if (expression?.type !== "ClassExpression" || expression.body.body.length !== 1) return undefined;
    const member = expression.body.body[0];
    return member?.type === "MethodDefinition" && member.kind !== "constructor" ? member.value : undefined;
  }

  function objectMethodIn(program: ES.Program): ES.FunctionExpression | undefined {
    const expression = soleExpression(program);
    if (expression?.type !== "ObjectExpression" || expression.properties.length !== 1) return undefined;
    const property = expression.properties[0];
    if (property?.type !== "Property" || (!property.method && property.kind === "init")) return undefined;
    return property.value.type === "FunctionExpression" ? property.value : undefined;
  }

  function functionIn(program: ES.Program): FunctionFound | undefined {
    const body = objectMethodIn(program)?.body.body;
    const statement = body?.length === 1 ? body[0] : undefined;
    const value = statement?.type === "ReturnStatement" ? statement.argument : undefined;
    return value?.type === "FunctionExpression" || value?.type === "ArrowFunctionExpression" ? value : undefined;
  }

  const wrappers = [
    { form: "function", prefix: "({ m() { return (", suffix: "\n) } })", find: functionIn },
    { form: "method", prefix: "(class {", suffix: "\n})", find: classMethodIn },
    { form: "method", prefix: "({", suffix: "\n})", find: objectMethodIn },
  ] as const;

  let root: FunctionFound | undefined;
  let form: "function" | "method" | undefined;
  let parsedOtherwise = false;
  // Of the failed parses, the one that got furthest into the source is the likeliest intended form.
  let syntaxError: { message: string; at: number } | undefined;
  search: for (const sourceType of ["module", "script"] as const) {
    for (const wrapper of wrappers) {
      let program: ES.Program;
      try {
        program = parse(wrapper.prefix + source + wrapper.suffix, sourceType) as ES.Program;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/ \(\d+:\d+\)$/, "");
        const pos = (error as { pos?: unknown } | null | undefined)?.pos;
        const at = typeof pos === "number" ? Math.min(Math.max(pos - wrapper.prefix.length, 0), source.length) : 0;
        if (!syntaxError || at > syntaxError.at) syntaxError = { message, at };
        continue;
      }
      const found = wrapper.find(program);
      if (!found) {
        parsedOtherwise = true;
        continue;
      }
      root = found;
      form = wrapper.form;
      offset = wrapper.prefix.length;
      break search;
    }
  }
  if (!root || !form) {
    if (parsedOtherwise || !syntaxError) {
      return failure("notAFunction", "the source is not a single function, method or accessor", 0, source.length);
    }
    return failure("syntax", syntaxError.message, syntaxError.at, syntaxError.at);
  }

  // Directives lead the body, before any other statement.
  let marked = false;
  if (root.body.type === "BlockStatement") {
    for (const statement of root.body.body) {
      if (!("directive" in statement)) break;
      if (statement.directive === "use hermetic") marked = true;
    }
  }

  function staticKey(node: ES.Node): string | undefined {
    if (node.type === "Literal") {
      const value = node.value;
      return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : undefined;
    }
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
    return undefined;
  }

  function memberKey(member: ES.MemberExpression): string | undefined {
    if (member.computed) return staticKey(member.property);
    return member.property.type === "Identifier" ? member.property.name : undefined;
  }

  function propertyKey(property: ES.Property): string | undefined {
    if (!property.computed && property.key.type === "Identifier") return property.key.name;
    return staticKey(property.key);
  }

  /** An identifier and the static member keys read from it, such as `Math.random` or `Math?.["random"]`. */
  function staticPath(node: ES.Node): { root: string; path: string[] } | undefined {
    const keys: string[] = [];
    let current = node;
    for (;;) {
      if (current.type === "ChainExpression") {
        current = current.expression;
      } else if (current.type === "MemberExpression") {
        const key = memberKey(current);
        if (key === undefined) return undefined;
        keys.unshift(key);
        current = current.object;
      } else {
        break;
      }
    }
    return current.type === "Identifier" ? { root: current.name, path: [current.name, ...keys] } : undefined;
  }

  /** Records the member paths a destructuring pattern reads, such as `Math.random` in `const { random } = Math`. */
  function destructured(pattern: ES.Pattern, value: ES.Node | null | undefined, context: Context): void {
    const base = value ? staticPath(value) : undefined;
    if (!base) return;
    const walk = (node: ES.Pattern, path: readonly string[]): void => {
      if (node.type === "AssignmentPattern") return walk(node.left, path);
      if (node.type !== "ObjectPattern") return;
      for (const property of node.properties) {
        if (property.type === "RestElement") continue;
        const key = propertyKey(property);
        if (key === undefined) continue;
        accesses.push({ root: base.root, scope: context.scope, path: [...path, key], node: property });
        walk(property.value, [...path, key]);
      }
    };
    walk(pattern, base.path);
  }

  function declare(pattern: ES.Pattern, context: Context, target: Scope): void {
    switch (pattern.type) {
      case "Identifier":
        target.names.add(pattern.name);
        return;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            declare(property.argument, context, target);
          } else {
            if (property.computed) visit(property.key, context);
            declare(property.value, context, target);
          }
        }
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) if (element) declare(element, context, target);
        return;
      case "AssignmentPattern":
        declare(pattern.left, context, target);
        visit(pattern.right, context);
        destructured(pattern.left, pattern.right, context);
        return;
      case "RestElement":
        declare(pattern.argument, context, target);
        return;
      default:
        visit(pattern, context);
    }
  }

  function assign(pattern: ES.Pattern, context: Context): void {
    switch (pattern.type) {
      case "Identifier":
        references.push({ name: pattern.name, scope: context.scope, node: pattern, write: true });
        return;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            assign(property.argument, context);
          } else {
            if (property.computed) visit(property.key, context);
            assign(property.value, context);
          }
        }
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) if (element) assign(element, context);
        return;
      case "AssignmentPattern":
        assign(pattern.left, context);
        visit(pattern.right, context);
        destructured(pattern.left, pattern.right, context);
        return;
      case "RestElement":
        assign(pattern.argument, context);
        return;
      default:
        visit(pattern, context);
    }
  }

  /**
   * Parameters get a scope of their own, so a default can't see the body's
   * declarations, and the body gets the next one. `home` marks a method or
   * accessor, whose `super` is its own when it is defined inside the checked
   * function.
   */
  function visitFunction(fn: ES.Function, outer: Context, home: boolean): void {
    let enclosing = outer.scope;
    if (fn.type === "FunctionExpression" && fn.id) {
      // A named function expression binds its own name, around its parameters.
      enclosing = scopeIn(enclosing);
      enclosing.names.add(fn.id.name);
    }
    const parameters = scopeIn(enclosing);
    const arrow = fn.type === "ArrowFunctionExpression";
    if (!arrow) parameters.names.add("arguments");
    const inner: Context = {
      scope: parameters,
      varScope: parameters,
      ownThis: arrow ? outer.ownThis : true,
      ownSuper: arrow ? outer.ownSuper : home,
    };
    for (const parameter of fn.params) declare(parameter, inner, parameters);
    const body = scopeIn(parameters);
    const bodyContext: Context = { ...inner, scope: body, varScope: body };
    if (fn.body.type === "BlockStatement") for (const statement of fn.body.body) visit(statement, bodyContext);
    else visit(fn.body, bodyContext);
  }

  function visitClass(node: ES.Class, context: Context): void {
    const scope = scopeIn(context.scope);
    if (node.id) scope.names.add(node.id.name);
    // The heritage and computed keys run in the enclosing context, with the class name in scope.
    const around: Context = { ...context, scope };
    if (node.superClass) visit(node.superClass, around);
    for (const member of node.body.body) {
      if (member.type === "StaticBlock") {
        const block = scopeIn(scope);
        const blockContext: Context = { scope: block, varScope: block, ownThis: true, ownSuper: true };
        for (const statement of member.body) visit(statement, blockContext);
        continue;
      }
      if (member.computed) visit(member.key, around);
      if (member.type === "MethodDefinition") visitFunction(member.value, around, true);
      else if (member.value) visit(member.value, { ...around, scope: scopeIn(scope), ownThis: true, ownSuper: true });
    }
  }

  function visitChildren(node: ES.Node, context: Context): void {
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "range") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, context);
      } else if (isNode(value)) {
        visit(value, context);
      }
    }
  }

  function visit(node: ES.Node, context: Context): void {
    switch (node.type) {
      case "Identifier":
        references.push({ name: node.name, scope: context.scope, node, write: false });
        return;
      case "ThisExpression":
        if (!context.ownThis) report("lexicalThis", "this", node);
        return;
      case "Super":
        if (!context.ownSuper) report("superReference", "super", node);
        return;
      case "MetaProperty":
        if (node.meta.name === "import") report("importMeta", "import.meta", node);
        else if (!context.ownThis) report("lexicalNewTarget", "new.target", node);
        return;
      case "ImportExpression":
        report("dynamicImport", "import()", node);
        visitChildren(node, context);
        return;
      case "MemberExpression": {
        const read = staticPath(node);
        if (read) accesses.push({ root: read.root, scope: context.scope, path: read.path, node });
        visit(node.object, context);
        if (node.computed) visit(node.property, context);
        return;
      }
      case "Property":
        if (node.computed) visit(node.key, context);
        if (node.method || node.kind !== "init") visitFunction(node.value as ES.FunctionExpression, context, true);
        else visit(node.value, context);
        return;
      case "FunctionDeclaration":
        if (node.id) context.scope.names.add(node.id.name);
        visitFunction(node, context, false);
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        visitFunction(node, context, false);
        return;
      case "ClassDeclaration":
        if (node.id) context.scope.names.add(node.id.name);
        visitClass(node, context);
        return;
      case "ClassExpression":
        visitClass(node, context);
        return;
      case "VariableDeclaration": {
        const target = node.kind === "var" ? context.varScope : context.scope;
        for (const declarator of node.declarations) {
          declare(declarator.id, context, target);
          destructured(declarator.id, declarator.init, context);
          if (declarator.init) visit(declarator.init, context);
        }
        return;
      }
      case "AssignmentExpression":
        if (node.left.type === "MemberExpression") visit(node.left, context);
        else assign(node.left, context);
        destructured(node.left, node.right, context);
        visit(node.right, context);
        return;
      case "UpdateExpression":
        if (node.argument.type === "Identifier") {
          references.push({ name: node.argument.name, scope: context.scope, node: node.argument, write: true });
        } else {
          visit(node.argument, context);
        }
        return;
      case "BlockStatement": {
        const block: Context = { ...context, scope: scopeIn(context.scope) };
        for (const statement of node.body) visit(statement, block);
        return;
      }
      case "ForStatement": {
        const loop: Context = { ...context, scope: scopeIn(context.scope) };
        if (node.init) visit(node.init, loop);
        if (node.test) visit(node.test, loop);
        if (node.update) visit(node.update, loop);
        visit(node.body, loop);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const loop: Context = { ...context, scope: scopeIn(context.scope) };
        if (node.left.type === "VariableDeclaration") visit(node.left, loop);
        else assign(node.left, loop);
        visit(node.right, loop);
        visit(node.body, loop);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant, context);
        const cases: Context = { ...context, scope: scopeIn(context.scope) };
        for (const branch of node.cases) {
          if (branch.test) visit(branch.test, cases);
          for (const statement of branch.consequent) visit(statement, cases);
        }
        return;
      }
      case "CatchClause": {
        const clause: Context = { ...context, scope: scopeIn(context.scope) };
        if (node.param) declare(node.param, clause, clause.scope);
        visit(node.body, clause);
        return;
      }
      case "LabeledStatement":
        visit(node.body, context);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "Literal":
      case "PrivateIdentifier":
        return;
      case "WithStatement":
        report("withStatement", "with", node);
        visitChildren(node, context);
        return;
      default:
        visitChildren(node, context);
    }
  }

  const outside = scopeIn(undefined);
  visitFunction(root, { scope: outside, varScope: outside, ownThis: false, ownSuper: false }, false);

  function isDenied(path: readonly string[]): boolean {
    return ground.deny.some(
      (denied) => denied.length === path.length && denied.every((segment, i) => segment === path[i]),
    );
  }

  /** True when `path` is denied and no shorter path it passes through is, so each read is reported once. */
  function firstDenied(path: readonly string[]): boolean {
    for (let length = 2; length <= path.length; length++) {
      if (isDenied(path.slice(0, length))) return length === path.length;
    }
    return false;
  }

  for (const reference of references) {
    if (resolves(reference.name, reference.scope)) continue;
    if (!ground.names.has(reference.name)) report("freeVariable", reference.name, reference.node);
    else if (reference.write) report("groundWrite", reference.name, reference.node);
  }
  for (const access of accesses) {
    if (resolves(access.root, access.scope) || !ground.names.has(access.root)) continue;
    if (firstDenied(access.path)) report("deniedPath", access.path.join("."), access.node);
  }
  problems.sort((a, b) => a.start - b.start || a.end - b.end);
  return { form, marked, hermetic: problems.length === 0, problems };
}
