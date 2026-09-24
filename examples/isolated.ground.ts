/**
 * The ground bootstrap: the one place that decides which globals isolated
 * functions may assume. This file spells out the default ground, so it is a
 * starting point to copy and edit.
 *
 * The linter lints this function with the rule itself, runs it in a fresh
 * `node:vm` realm, and reads the keys of `allow` and the paths in `deny`. At
 * runtime, the entry point can call it with the real `globalThis`, for example
 * to build Compartment globals, so lint time and runtime share one definition.
 *
 * Keep it a literal list. At lint time `realm` is a bare JavaScript realm, so
 * a bootstrap that enumerates `realm` would see different names than it sees
 * at runtime.
 */
export function ground(realm: typeof globalThis) {
  "use isolated";
  return {
    allow: {
      // Value globals
      undefined: undefined,
      NaN: realm.NaN,
      Infinity: realm.Infinity,
      // Data structures
      Array: realm.Array,
      Object: realm.Object,
      Map: realm.Map,
      Set: realm.Set,
      WeakMap: realm.WeakMap,
      WeakSet: realm.WeakSet,
      Symbol: realm.Symbol,
      // Primitives
      Number: realm.Number,
      String: realm.String,
      Boolean: realm.Boolean,
      BigInt: realm.BigInt,
      parseInt: realm.parseInt,
      parseFloat: realm.parseFloat,
      isNaN: realm.isNaN,
      isFinite: realm.isFinite,
      // Structured data
      JSON: realm.JSON,
      RegExp: realm.RegExp,
      Promise: realm.Promise,
      Error: realm.Error,
      AggregateError: realm.AggregateError,
      EvalError: realm.EvalError,
      RangeError: realm.RangeError,
      ReferenceError: realm.ReferenceError,
      SyntaxError: realm.SyntaxError,
      TypeError: realm.TypeError,
      URIError: realm.URIError,
      // Math, minus the nondeterministic part
      Math: realm.Math,
    },
    deny: ["Math.random"],
  };
}
