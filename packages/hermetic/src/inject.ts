import { check } from "./check.ts";
import { HermeticError, notHermetic } from "./confine.ts";

/**
 * Binds a hermetic function to exactly what it reads: a frozen object with
 * the names it reads from `this`, each taken from `env`, which may hold more.
 *
 * `env` is any object, so a DI container can be one. A name is there when
 * `name in env`, or when `env` reports an own property by that name, as a
 * proxy-based container may. Each value is read once, when `inject` runs.
 *
 * The result keeps the function's type parameters, and TypeScript checks
 * `env` against its `this` type.
 *
 * @throws {HermeticError} When the function isn't hermetic, when it uses
 *   `this` other than to read names from it, so they can't be listed, or
 *   when `env` lacks one of them.
 */
export function inject<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, env: NoInfer<T>): (...args: A) => R {
  const source = Function.prototype.toString.call(fn);
  const { hermetic, problems, needs } = check(source);
  if (!hermetic) throw notHermetic(source, problems);
  if (!needs) {
    const message = "Can't list what it reads from 'this': it uses 'this' other than to read names from it, as in this[key] or helper(this).";
    throw new HermeticError(message, source, []);
  }
  if ((typeof env !== "object" && typeof env !== "function") || env === null) {
    throw new TypeError(`The environment must be an object, not ${env === null ? "null" : typeof env}.`);
  }
  const provides = (name: string) => name in env || Reflect.getOwnPropertyDescriptor(env, name) !== undefined;
  const missing = needs.filter((name) => !provides(name));
  if (missing.length > 0) {
    const names = missing.map((name) => `'${name}'`).join(", ");
    throw new HermeticError(`The environment lacks ${names}, which the function reads from 'this'.`, source, []);
  }
  const picked: Record<string, unknown> = Object.create(null);
  for (const name of needs) picked[name] = (env as Record<string, unknown>)[name];
  return fn.bind(Object.freeze(picked) as T);
}
