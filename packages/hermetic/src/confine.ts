import { check, type FunctionLike, type Problem } from "./check.ts";
import { createGround, DEFAULT_GROUND, type GroundConfig } from "./ground.ts";

/**
 * A ground bootstrap: a hermetic function that picks the allowed globals out
 * of the realm it is given. The linter calls it with a bare realm, and
 * `confine` with the global object of the compartment it builds.
 */
export type GroundBootstrap = (realm: typeof globalThis) => GroundConfig;

export interface ConfineOptions {
  /**
   * The bootstrap that chooses the allowed globals, the same one the linter
   * loads. Without one, the default allowed globals apply.
   */
  readonly ground?: GroundBootstrap;
}

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
 * compartment, whose global object holds only the allowed globals. Returns
 * the function the compartment made, hardened.
 *
 * `check` makes sure the function reads nothing but its inputs and the
 * allowed globals by name. The compartment covers what names can't show: its
 * built-ins are frozen, so the function can't change them for the rest of the
 * program, and a clock or random number reached through an alias throws.
 * Anything passed to the function is still its to change, so harden inputs
 * that it shouldn't.
 *
 * Hardened JS is the application's choice, since `lockdown()` freezes the
 * built-ins of the whole program: install `ses`, import it and call
 * `lockdown()` first. Without that, `confine` throws.
 *
 * @throws {HermeticError} When the function isn't hermetic, or the
 *   compartment refuses its source.
 */
export function confine<F extends FunctionLike = (...args: unknown[]) => unknown>(
  fn: string | F,
  options: ConfineOptions = {},
): F {
  const { Compartment, harden } = hardenedJs();
  const source = typeof fn === "function" ? Function.prototype.toString.call(fn) : fn;
  const compartment = new Compartment({ __options__: true });
  const realm = compartment.globalThis;
  const config = options.ground?.(realm as typeof globalThis);

  const result = check(source, config);
  if (!result.hermetic) {
    const found = result.problems.map((problem) => `${explain(problem)} (at ${problem.start})`);
    throw new HermeticError(`Not hermetic: ${found.join("; ")}.`, source, result.problems);
  }

  // Leave the compartment only the allowed globals, then freeze its global
  // object, so the function can keep nothing there between calls.
  const ground = config ? createGround(Object.keys(config.allow), config.deny) : DEFAULT_GROUND;
  for (const key of Reflect.ownKeys(realm)) {
    if (typeof key === "string" && !ground.names.has(key)) Reflect.deleteProperty(realm, key);
  }
  if (config) {
    for (const name of ground.names) {
      const value = config.allow[name];
      if (!(name in realm) || realm[name] !== value) realm[name] = harden(value);
    }
  }
  harden(realm);

  let confined: unknown;
  try {
    confined = result.form === "method" ? onlyMember(compartment.evaluate(`({${source}\n})`)) : compartment.evaluate(`(${source}\n)`);
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

/** The method or accessor an object literal of one member holds. */
function onlyMember(object: unknown): unknown {
  const [key] = Reflect.ownKeys(object as object);
  const descriptor = key === undefined ? undefined : Reflect.getOwnPropertyDescriptor(object as object, key);
  return descriptor?.value ?? descriptor?.get ?? descriptor?.set;
}

function explain(problem: Problem): string {
  const { kind, name } = problem;
  switch (kind) {
    case "freeVariable":
      return `'${name}' is a free variable`;
    case "groundWrite":
      return `it assigns to the allowed global '${name}'`;
    case "deniedPath":
      return `'${name}' is not allowed`;
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
    case "syntax":
      return `it does not parse: ${name}`;
    case "notAFunction":
      return "it is not a single function, method, accessor or class";
  }
}
