import { parse as acornParse } from "acorn";
import type * as ES from "estree";

/**
 * The global object's three immutable values. A hermetic function may read
 * them as if they were keywords, unless something outside it declares the name.
 */
export const IMMUTABLE_GLOBALS: readonly string[] = ["undefined", "NaN", "Infinity"];

/**
 * Parses JavaScript into an ESTree program whose nodes carry `start` and `end`
 * offsets, as acorn's do, and throws on a syntax error. A method's source
 * doesn't include its class, so the parser must accept private names that are
 * never declared, as acorn does with `checkPrivateFields: false`.
 */
export type Parse = (source: string, sourceType: "module" | "script") => unknown;

/** What `checkHermetic` receives as `this`. */
export interface CheckContext {
  readonly parse: Parse;
}

export type ProblemKind =
  /** A name the function reads that isn't declared inside it: an import, a module-level variable, a global. */
  | "freeVariable"
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
  /**
   * The source is a method, accessor or class, which can't be hermetic yet:
   * its `this` is its object, not its inputs. `name` says which.
   */
  | "method"
  /** The source doesn't parse; `name` holds the parser's message. */
  | "syntax"
  /** The source parses, but not as a single function, method, accessor or class. */
  | "notAFunction";

export interface Problem {
  readonly kind: ProblemKind;
  /** The name or construct involved, or the parser's message for `syntax`. */
  readonly name: string;
  /**
   * Offsets into the checked source. A `syntax` problem marks where parsing
   * stopped, when the parser says; `method` and `notAFunction` span the whole source.
   */
  readonly start: number;
  readonly end: number;
}

export interface CheckResult {
  /**
   * `"function"` for a function or arrow function, `"method"` for a method or
   * accessor, `"class"` for a class, and undefined when the source is none of
   * these. Only functions can be hermetic.
   */
  readonly form: "function" | "method" | "class" | undefined;
  /** Its body starts with a `"use hermetic"` directive; for a class, its constructor's body. */
  readonly marked: boolean;
  /** It is a function that reads nothing but its inputs. */
  readonly hermetic: boolean;
  readonly problems: readonly Problem[];
  /**
   * The names the function reads from `this`, in the order it first reads
   * them: `this.name`, or `const { name } = this`. Undefined when it uses
   * `this` in a way that doesn't name what it reads, as in `this[key]` or
   * `helper(this)`, and for anything but a function. An arrow function's
   * `this` isn't one of its inputs, so it needs nothing.
   */
  readonly needs: readonly string[] | undefined;
}

/** A function or a class. */
export type FunctionLike = ((...args: never[]) => unknown) | (abstract new (...args: never[]) => unknown);

/**
 * Checks one function's source, as `Function.prototype.toString` returns it,
 * using acorn as the parser.
 */
export function check(fn: string | FunctionLike): CheckResult {
  const source = typeof fn === "function" ? Function.prototype.toString.call(fn) : fn;
  return checkHermetic.call({ parse: parseWithAcorn }, source);
}

const parseWithAcorn: Parse = (source, sourceType) =>
  acornParse(source, { ecmaVersion: "latest", sourceType, checkPrivateFields: false });

/**
 * Checks one function's source for everything it reads besides its inputs.
 *
 * It is itself hermetic: the parser arrives through `this`, every helper is
 * nested inside it, and it reads no globals, so its source is complete on its
 * own and can be evaluated and bound in any runtime.
 */
export function checkHermetic(this: CheckContext, source: string): CheckResult {
  "use hermetic";
  const parse = this.parse;
  const immutable = ["undefined", "NaN", "Infinity"];

  interface Scope {
    readonly parent: Scope | undefined;
    readonly names: string[];
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
    /** `this` is the checked function's own, one of its inputs. */
    readonly rootThis: boolean;
  }
  type FunctionFound = ES.FunctionExpression | ES.ArrowFunctionExpression;
  type Found = FunctionFound | ES.ClassExpression;
  type Positioned = { readonly start: number; readonly end: number };

  const problems: Problem[] = [];
  const references: { name: string; scope: Scope; node: ES.Node }[] = [];
  const needs: string[] = [];
  /** The function uses its `this` other than to read names from it. */
  let unlisted = false;
  let offset = 0;

  function report(kind: ProblemKind, name: string, node: ES.Node): void {
    const { start, end } = node as unknown as Positioned;
    problems.push({ kind, name, start: start - offset, end: end - offset });
  }

  function failure(kind: ProblemKind, name: string, start: number, end: number): CheckResult {
    return { form: undefined, marked: false, hermetic: false, problems: [{ kind, name, start, end }], needs: undefined };
  }

  function need(name: string): void {
    if (!needs.includes(name)) needs.push(name);
  }

  /** Records the names a pattern takes from the function's `this`; anything it can't name makes the list incomplete. */
  function destructure(pattern: ES.Pattern): void {
    if (pattern.type !== "ObjectPattern") {
      unlisted = true;
      return;
    }
    for (const property of pattern.properties) {
      if (property.type === "RestElement" || property.computed) unlisted = true;
      else if (property.key.type === "Identifier") need(property.key.name);
      else if (property.key.type === "Literal" && typeof property.key.value === "string") need(property.key.value);
      else unlisted = true;
    }
  }

  function scopeIn(parent: Scope | undefined): Scope {
    return { parent, names: [] };
  }

  function resolves(name: string, from: Scope | undefined): boolean {
    for (let scope = from; scope; scope = scope.parent) if (scope.names.includes(name)) return true;
    return false;
  }

  function isNode(value: unknown): value is ES.Node {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
  }

  /** A list of child nodes, told apart from a node without reaching for `Array.isArray`. */
  function isList(value: unknown): value is readonly unknown[] {
    return typeof value === "object" && value !== null && typeof (value as { length?: unknown }).length === "number";
  }

  // A function, arrow function or class parses as what a method returns, where
  // `super` and `new.target` in an arrow function parse, to be reported. A method or
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
    if (member?.type !== "MethodDefinition" || member.kind === "constructor") return undefined;
    accessor = member.kind !== "method";
    return member.value;
  }

  function objectMethodIn(program: ES.Program): ES.FunctionExpression | undefined {
    const expression = soleExpression(program);
    if (expression?.type !== "ObjectExpression" || expression.properties.length !== 1) return undefined;
    const property = expression.properties[0];
    if (property?.type !== "Property" || (!property.method && property.kind === "init")) return undefined;
    if (property.value.type !== "FunctionExpression") return undefined;
    accessor = property.kind !== "init";
    return property.value;
  }

  function functionIn(program: ES.Program): Found | undefined {
    const body = objectMethodIn(program)?.body.body;
    const statement = body?.length === 1 ? body[0] : undefined;
    const value = statement?.type === "ReturnStatement" ? statement.argument : undefined;
    return value?.type === "FunctionExpression" ||
      value?.type === "ArrowFunctionExpression" ||
      value?.type === "ClassExpression"
      ? value
      : undefined;
  }

  const wrappers = [
    { form: "function", prefix: "({ m() { return (", suffix: "\n) } })", find: functionIn },
    { form: "method", prefix: "(class {", suffix: "\n})", find: classMethodIn },
    { form: "method", prefix: "({", suffix: "\n})", find: objectMethodIn },
  ] as const;

  let root: Found | undefined;
  let form: "function" | "method" | "class" | undefined;
  /** The method found is a getter or setter. */
  let accessor = false;
  let parsedOtherwise = false;
  // Of the failed parses, the one that got furthest into the source is the likeliest intended form.
  let syntaxError: { message: string; at: number } | undefined;
  search: for (const sourceType of ["module", "script"] as const) {
    for (const wrapper of wrappers) {
      let program: ES.Program;
      try {
        program = parse(wrapper.prefix + source + wrapper.suffix, sourceType) as ES.Program;
      } catch (error) {
        const thrown = error as { message?: unknown; pos?: unknown } | null | undefined;
        const message = (typeof thrown?.message === "string" ? thrown.message : `${error}`).replace(/ \(\d+:\d+\)$/, "");
        const pos = typeof thrown?.pos === "number" ? thrown.pos - wrapper.prefix.length : 0;
        const at = pos < 0 ? 0 : pos > source.length ? source.length : pos;
        if (!syntaxError || at > syntaxError.at) syntaxError = { message, at };
        continue;
      }
      const found = wrapper.find(program);
      if (!found) {
        parsedOtherwise = true;
        continue;
      }
      root = found;
      form = found.type === "ClassExpression" ? "class" : wrapper.form;
      offset = wrapper.prefix.length;
      break search;
    }
  }
  if (!root || !form) {
    if (parsedOtherwise || !syntaxError) {
      return failure("notAFunction", "the source is not a single function, method, accessor or class", 0, source.length);
    }
    return failure("syntax", syntaxError.message, syntaxError.at, syntaxError.at);
  }

  // Directives lead a function's body, before any other statement. A class is its constructor.
  const markable =
    root.type === "ClassExpression"
      ? root.body.body.find(
          (member): member is ES.MethodDefinition => member.type === "MethodDefinition" && member.kind === "constructor",
        )?.value
      : root;
  let marked = false;
  if (markable?.body.type === "BlockStatement") {
    for (const statement of markable.body.body) {
      if (!("directive" in statement)) break;
      if (statement.directive === "use hermetic") marked = true;
    }
  }
  // A method's or class's `this` is its object, not its inputs, so neither can be hermetic yet.
  if (form !== "function") {
    const name = form === "class" ? "class" : accessor ? "accessor" : "method";
    return { form, marked, hermetic: false, problems: [{ kind: "method", name, start: 0, end: source.length }], needs: undefined };
  }

  function declare(pattern: ES.Pattern, context: Context, target: Scope): void {
    switch (pattern.type) {
      case "Identifier":
        target.names.push(pattern.name);
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
        references.push({ name: pattern.name, scope: context.scope, node: pattern });
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
   * function, and `root` the checked function itself.
   */
  function visitFunction(fn: ES.Function, outer: Context, home: boolean, root: boolean): void {
    let enclosing = outer.scope;
    if (fn.type === "FunctionExpression" && fn.id) {
      // A named function expression binds its own name, around its parameters.
      enclosing = scopeIn(enclosing);
      enclosing.names.push(fn.id.name);
    }
    const parameters = scopeIn(enclosing);
    const arrow = fn.type === "ArrowFunctionExpression";
    if (!arrow) parameters.names.push("arguments");
    const inner: Context = {
      scope: parameters,
      varScope: parameters,
      ownThis: arrow ? outer.ownThis : true,
      ownSuper: arrow ? outer.ownSuper : home,
      rootThis: arrow ? outer.rootThis : root,
    };
    for (const parameter of fn.params) declare(parameter, inner, parameters);
    const body = scopeIn(parameters);
    const bodyContext: Context = { ...inner, scope: body, varScope: body };
    if (fn.body.type === "BlockStatement") for (const statement of fn.body.body) visit(statement, bodyContext);
    else visit(fn.body, bodyContext);
  }

  function visitClass(node: ES.Class, context: Context): void {
    const scope = scopeIn(context.scope);
    if (node.id) scope.names.push(node.id.name);
    // The heritage and computed keys run in the enclosing context, with the class name in scope.
    const around: Context = { ...context, scope };
    if (node.superClass) visit(node.superClass, around);
    for (const member of node.body.body) {
      if (member.type === "StaticBlock") {
        const block = scopeIn(scope);
        const blockContext: Context = { scope: block, varScope: block, ownThis: true, ownSuper: true, rootThis: false };
        for (const statement of member.body) visit(statement, blockContext);
        continue;
      }
      if (member.computed) visit(member.key, around);
      if (member.type === "MethodDefinition") visitFunction(member.value, around, true, false);
      else if (member.value) visit(member.value, { ...around, scope: scopeIn(scope), ownThis: true, ownSuper: true, rootThis: false });
    }
  }

  function visitChildren(node: ES.Node, context: Context): void {
    const fields = node as unknown as { readonly [key: string]: unknown };
    for (const key in fields) {
      if (key === "loc" || key === "range") continue;
      const value = fields[key];
      if (isNode(value)) visit(value, context);
      else if (isList(value)) for (const item of value) if (isNode(item)) visit(item, context);
    }
  }

  function visit(node: ES.Node, context: Context): void {
    switch (node.type) {
      case "Identifier":
        references.push({ name: node.name, scope: context.scope, node });
        return;
      case "ThisExpression":
        if (!context.ownThis) report("lexicalThis", "this", node);
        else if (context.rootThis) unlisted = true;
        return;
      case "Super":
        if (!context.ownSuper) report("superReference", "super", node);
        return;
      case "MetaProperty":
        if (node.meta.name === "import") report("importMeta", "import.meta", node);
        else if (!context.ownThis) report("lexicalNewTarget", "new.target", node);
        return;
      case "ImportExpression":
        // In two parts, so this function's source never spells out a dynamic
        // import: Hardened JS refuses to evaluate that text, even in a string.
        report("dynamicImport", "import" + "()", node);
        visitChildren(node, context);
        return;
      case "MemberExpression":
        if (node.object.type === "ThisExpression" && context.rootThis) {
          if (node.computed) unlisted = true;
          else if (node.property.type === "Identifier") need(node.property.name);
        } else {
          visit(node.object, context);
        }
        if (node.computed) visit(node.property, context);
        return;
      case "Property":
        if (node.computed) visit(node.key, context);
        if (node.method || node.kind !== "init") visitFunction(node.value as ES.FunctionExpression, context, true, false);
        else visit(node.value, context);
        return;
      case "FunctionDeclaration":
        if (node.id) context.scope.names.push(node.id.name);
        visitFunction(node, context, false, false);
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        visitFunction(node, context, false, false);
        return;
      case "ClassDeclaration":
        if (node.id) context.scope.names.push(node.id.name);
        visitClass(node, context);
        return;
      case "ClassExpression":
        visitClass(node, context);
        return;
      case "VariableDeclaration": {
        const target = node.kind === "var" ? context.varScope : context.scope;
        for (const declarator of node.declarations) {
          declare(declarator.id, context, target);
          if (declarator.init?.type === "ThisExpression" && context.rootThis) destructure(declarator.id);
          else if (declarator.init) visit(declarator.init, context);
        }
        return;
      }
      case "AssignmentExpression":
        if (node.left.type === "MemberExpression") visit(node.left, context);
        else assign(node.left, context);
        if (node.right.type === "ThisExpression" && context.rootThis && node.operator === "=") destructure(node.left);
        else visit(node.right, context);
        return;
      case "UpdateExpression":
        visit(node.argument, context);
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
  visitFunction(root as ES.Function, { scope: outside, varScope: outside, ownThis: false, ownSuper: false, rootThis: false }, false, true);

  for (const reference of references) {
    if (resolves(reference.name, reference.scope) || immutable.includes(reference.name)) continue;
    report("freeVariable", reference.name, reference.node);
  }
  problems.sort((a, b) => a.start - b.start || a.end - b.end);
  return { form, marked, hermetic: problems.length === 0, problems, needs: unlisted ? undefined : needs };
}
