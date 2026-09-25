import { check, type FunctionLike, type Problem } from "./check.ts";

/** Thrown by `confine` when a function isn't hermetic, or can't be evaluated in a compartment. */
export class HermeticError extends Error {
  override name = "HermeticError";
  /** The source that was confined. */
  readonly source: string;
  /** What `check` found; empty when the source was hermetic but couldn't be evaluated. */
  readonly problems: readonly Problem[];

  constructor(message: string, source: string, problems: readonly Problem[], options?: ErrorOptions) {
    super(message, options);
    this.source = source;
    this.problems = problems;
  }
}

interface Compartment {
  readonly globalThis: Record<string, unknown>;
  evaluate(source: string): unknown;
}

/** What Hardened JS's `lockdown()` leaves on the global object. */
interface HardenedJs {
  readonly Compartment: new (options: { readonly __options__: true }) => Compartment;
  readonly harden: <T>(value: T) => T;
}

/**
 * Checks a function and evaluates its source in a new Hardened JS
 * compartment whose global object is empty, and returns the function the
 * compartment made, hardened. A hermetic function reads nothing but its
 * inputs, so everything it uses comes through `this` and its arguments: bind
 * or call it with them.
 *
 * `check` makes sure the function names nothing outside itself. The
 * compartment covers what names can't show: values still lead through their
 * prototype chains to built-ins the whole program shares, and in a
 * compartment those are frozen, so the function can't change them for the
 * rest of the program. Anything passed to the function is still its to
 * change, so harden inputs that it shouldn't.
 *
 * Hardened JS is the application's choice, since `lockdown()` freezes the
 * built-ins of the whole program: install `ses`, import it and call
 * `lockdown()` first. Without that, `confine` throws.
 *
 * @throws {HermeticError} When the function isn't hermetic, or the
 *   compartment refuses its source.
 */
export function confine<F extends FunctionLike = (...args: unknown[]) => unknown>(fn: string | F): F {
  const { Compartment, harden } = hardenedJs();
  const source = typeof fn === "function" ? Function.prototype.toString.call(fn) : fn;
  const result = check(source);
  if (!result.hermetic) throw notHermetic(source, result.problems);

  // Empty the global object, then freeze it, so the function can keep nothing
  // there between calls. Only undefined, NaN and Infinity can't be deleted.
  const compartment = new Compartment({ __options__: true });
  const realm = compartment.globalThis;
  for (const key of Reflect.ownKeys(realm)) if (typeof key === "string") Reflect.deleteProperty(realm, key);
  harden(realm);

  let confined: unknown;
  try {
    confined = compartment.evaluate(`(${source}\n)`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HermeticError(`The compartment could not evaluate it: ${reason}`, source, [], { cause: error });
  }
  return harden(confined) as F;
}

function hardenedJs(): HardenedJs {
  const { Compartment, harden } = globalThis as unknown as Partial<HardenedJs>;
  if (typeof Compartment !== "function" || typeof harden !== "function" || !Object.isFrozen(Object.prototype)) {
    throw new Error("confine needs Hardened JS: install ses, import it, and call lockdown() before confining a function.");
  }
  return { Compartment, harden };
}

/** The error for a function that isn't hermetic, naming each problem and where it is. */
export function notHermetic(source: string, problems: readonly Problem[]): HermeticError {
  const found = problems.map((problem) => `${explain(problem)} (at ${problem.start})`);
  return new HermeticError(`Not hermetic: ${found.join("; ")}.`, source, problems);
}

function explain(problem: Problem): string {
  const { kind, name } = problem;
  switch (kind) {
    case "freeVariable":
      return `'${name}' is a free variable`;
    case "lexicalThis":
      return "'this' in an arrow function comes from the enclosing scope";
    case "lexicalNewTarget":
      return "'new.target' in an arrow function comes from the enclosing scope";
    case "superReference":
      return "'super' refers to the enclosing class or object";
    case "importMeta":
      return "'import.meta' refers to the enclosing module";
    case "dynamicImport":
      return "import() loads a module that is not one of its inputs";
    case "withStatement":
      return "a 'with' statement can turn any name into a member of its object";
    case "method":
      return `it is a ${name}, which can't be hermetic yet`;
    case "syntax":
      return `it does not parse: ${name}`;
    case "notAFunction":
      return "it is not a single function";
  }
}
