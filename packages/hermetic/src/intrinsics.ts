/**
 * The deterministic built-ins a binding can hand a hermetic function, such as
 * `Array`, `JSON` and `Math`, which it can't read by name.
 */
export interface Intrinsics {
  readonly Array: ArrayConstructor;
  readonly Object: ObjectConstructor;
  readonly Map: MapConstructor;
  readonly Set: SetConstructor;
  readonly WeakMap: WeakMapConstructor;
  readonly WeakSet: WeakSetConstructor;
  readonly Symbol: SymbolConstructor;
  readonly Number: NumberConstructor;
  readonly String: StringConstructor;
  readonly Boolean: BooleanConstructor;
  readonly BigInt: BigIntConstructor;
  readonly parseInt: typeof parseInt;
  readonly parseFloat: typeof parseFloat;
  readonly isNaN: typeof isNaN;
  readonly isFinite: typeof isFinite;
  readonly JSON: JSON;
  readonly RegExp: RegExpConstructor;
  readonly Promise: PromiseConstructor;
  readonly Error: ErrorConstructor;
  readonly AggregateError: AggregateErrorConstructor;
  readonly EvalError: EvalErrorConstructor;
  readonly RangeError: RangeErrorConstructor;
  readonly ReferenceError: ReferenceErrorConstructor;
  readonly SyntaxError: SyntaxErrorConstructor;
  readonly TypeError: TypeErrorConstructor;
  readonly URIError: URIErrorConstructor;
  /** `Math` without `random`. */
  readonly Math: Omit<Math, "random">;
}

/**
 * Picks the deterministic built-ins out of `realm`, for bindings to pass
 * through `this`. Left out: `Math.random`; `Date`, which reads the clock;
 * `Intl`, which depends on the host's locale; and everything that reaches the
 * host or loads code, such as `fetch`, `console`, timers, `eval` and
 * `Function`. The result is frozen, but the built-ins in it are only frozen
 * under Hardened JS.
 *
 * Pass it `globalThis`, or under Hardened JS a new compartment's global
 * object, whose clock and `Math.random` already throw. It is itself hermetic.
 */
export function intrinsics(realm: typeof globalThis): Intrinsics {
  "use hermetic";
  const descriptors: PropertyDescriptorMap = realm.Object.getOwnPropertyDescriptors(realm.Math);
  const kept = realm.Reflect.ownKeys(descriptors).flatMap((key) => {
    const descriptor = descriptors[key];
    return key === "random" || !descriptor ? [] : [[key, descriptor] as const];
  });
  const math = realm.Object.freeze(realm.Object.create(realm.Object.getPrototypeOf(realm.Math), realm.Object.fromEntries(kept)));
  return realm.Object.freeze({
    Array: realm.Array,
    Object: realm.Object,
    Map: realm.Map,
    Set: realm.Set,
    WeakMap: realm.WeakMap,
    WeakSet: realm.WeakSet,
    Symbol: realm.Symbol,
    Number: realm.Number,
    String: realm.String,
    Boolean: realm.Boolean,
    BigInt: realm.BigInt,
    parseInt: realm.parseInt,
    parseFloat: realm.parseFloat,
    isNaN: realm.isNaN,
    isFinite: realm.isFinite,
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
    Math: math as Omit<Math, "random">,
  });
}
