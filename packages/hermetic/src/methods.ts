import { check } from "./check.ts";
import { HermeticError, notHermetic } from "./confine.ts";

/** Any class, abstract or not. */
type AnyClass = abstract new (...args: never[]) => object;

/** Functions to install, by the name each gets on the class. */
type Functions = Record<string, (...args: never[]) => unknown>;

/** The functions as an instance has them: methods, without their `this` parameter. */
export type Installed<M extends Functions> = { [K in keyof M]: OmitThisParameter<M[K]> };

/**
 * Each function, required to accept as its `this` an instance of the class
 * with every function installed, so one can call another through `this`. A
 * function that needs more than the instance has is a type error at its name.
 */
export type Fitting<I, M extends Functions> = {
  [K in keyof M]: M[K] extends (this: infer T, ...args: infer A) => infer R
    ? [I & Installed<M>] extends [T]
      ? M[K]
      : (this: I & Installed<M>, ...args: A) => R
    : M[K];
};

/** A constructor of `I` taking what `C` takes, abstract when `C` is. */
type Constructing<C extends AnyClass, I> = C extends new (...args: never[]) => object
  ? new (...args: ConstructorParameters<C>) => I
  : abstract new (...args: ConstructorParameters<C>) => I;

/**
 * The class, whose instances have the installed functions as methods. It has
 * one constructor, so a class can extend it, and keeps the class's statics.
 */
export type WithMethods<C extends AnyClass, M extends Functions> = Constructing<C, InstanceType<C> & Installed<M>> & {
  readonly prototype: InstanceType<C> & Installed<M>;
} & Omit<C, "prototype">;

/**
 * Installs hermetic functions on a class, as its methods. Each reads nothing
 * but its arguments and `this`, which an instance of the class provides, so
 * the same function can be tested alone with any object that has what it
 * reads, and composed into as many classes as fit it.
 *
 * The functions go on the class's prototype as a class's own methods do:
 * writable, configurable and not enumerable. The class itself is returned,
 * typed with the new methods, and TypeScript checks each function's `this`
 * against an instance.
 *
 * @throws {HermeticError} When a function isn't hermetic, or is a class.
 * @throws {TypeError} When `base` isn't a class, a value isn't a function, or
 *   the class already has a member of its own by one of the names. Every
 *   function is checked before any is installed, so a failure leaves the
 *   class as it was.
 */
export function methods<C extends AnyClass, M extends Functions>(base: C, functions: M & Fitting<InstanceType<C>, M>): WithMethods<C, M> {
  const prototype: unknown = typeof base === "function" ? base.prototype : undefined;
  if (typeof prototype !== "object" || prototype === null) throw new TypeError("methods() installs functions on a class, and takes the class first.");
  const entries = Object.entries(functions as M);
  for (const [name, fn] of entries) {
    if (typeof fn !== "function") throw new TypeError(`'${name}' is not a function.`);
    const source = Function.prototype.toString.call(fn);
    const result = check(source);
    if (result.form === "class") throw new HermeticError(`Can't install '${name}': it is a class, not a function or method.`, source, []);
    if (!result.hermetic) {
      throw new HermeticError(`Can't install '${name}': ${notHermetic(source, result.problems).message}`, source, result.problems);
    }
    if (Object.hasOwn(prototype, name)) throw new TypeError(`The class already has '${name}' of its own.`);
  }
  for (const [name, fn] of entries) Object.defineProperty(prototype, name, { value: fn, writable: true, enumerable: false, configurable: true });
  // The prototype has the methods now, which the type of `base` can't show.
  return base as unknown as WithMethods<C, M>;
}
