import { check } from "./check.ts";
import { notHermetic } from "./confine.ts";

/**
 * A value in a recording. A recording is JSON: an object with a `$` key stands
 * for a value JSON can't hold, or for a value that isn't data, by its id.
 */
export type Encoded = null | boolean | number | string | readonly Encoded[] | { readonly [key: string]: Encoded };

/** How an operation ended: with a value, or by throwing one. */
export type Result = { readonly value: Encoded } | { readonly error: Encoded };

export type Operation = "get" | "set" | "has" | "delete" | "keys" | "describe" | "define" | "prototype" | "call" | "new" | "settle";

/**
 * One operation between a hermetic function and its inputs.
 *
 * `by: "fn"` is the function acting on one of its inputs, input `target`.
 * `by: "env"` is the other side acting on a value the function gave it, the
 * function's own value `target`, such as calling back a callback, or settling
 * a promise it gave the function, input `target`. `during` holds what the
 * other side did before the operation ended.
 */
export interface Event {
  readonly by: "fn" | "env";
  readonly op: Operation;
  readonly target: number;
  readonly key?: Encoded;
  readonly this?: Encoded;
  readonly args?: readonly Encoded[];
  readonly result?: Result;
  readonly during?: readonly Event[];
}

/**
 * One call of a hermetic function: what it was given, everything it did with
 * that, in order, and how the call ended. For a call that returned a promise,
 * `outcome` is how the promise settled, and `async` is true.
 */
export interface Recording {
  readonly this: Encoded;
  readonly args: readonly Encoded[];
  readonly events: readonly Event[];
  readonly outcome: Result & { readonly async?: true };
}

/** Thrown by `replay` when the function doesn't do what the recorded call did. */
export class ReplayError extends Error {
  override name = "ReplayError";
}

/**
 * Wraps a hermetic function so that each call records everything it does with
 * its inputs: `this`, its arguments, and whatever it reaches through them. The
 * function runs as `fn.call(env, ...args)` would, and `onRecording` receives
 * each call's recording when the call ends, or for a call that returns a
 * promise, when the promise settles.
 *
 * Plain data, such as numbers, strings, arrays and plain objects, crosses as
 * data, and the recording holds a copy of it. Anything else, such as a
 * function, a class instance, or `this` itself, crosses as a proxy that
 * records what is done with it, and the recording refers to it by its id.
 *
 * @throws {HermeticError} When the function isn't hermetic, since its
 *   recording would miss what it reads besides its inputs.
 */
export function record<T, A extends unknown[], R>(
  fn: (this: T, ...args: A) => R,
  env: NoInfer<T>,
  onRecording: (recording: Recording) => void,
): (...args: A) => R {
  mustBeHermetic(fn);
  return (...args: A): R => {
    const recorder = new Recorder();
    const self = recorder.root(env);
    const given = args.map((arg) => recorder.toFn(arg));
    const end = (outcome: Recording["outcome"]): void => {
      recorder.close();
      onRecording({ this: self.encoded, args: given.map((arg) => arg.encoded), events: recorder.events, outcome });
    };
    let result: unknown;
    try {
      result = Reflect.apply(fn, self.give, given.map((arg) => arg.give));
    } catch (error) {
      const thrown = recorder.toEnv(error);
      end({ error: thrown.encoded });
      throw thrown.give;
    }
    if (!(result instanceof Promise)) {
      const returned = recorder.toEnv(result);
      end({ value: returned.encoded });
      return returned.give as R;
    }
    return result.then(
      (value: unknown) => {
        const fulfilled = recorder.toEnv(value);
        end({ value: fulfilled.encoded, async: true });
        return fulfilled.give;
      },
      (error: unknown) => {
        const rejected = recorder.toEnv(error);
        end({ error: rejected.encoded, async: true });
        throw rejected.give;
      },
    ) as R;
  };
}

/**
 * Calls a hermetic function as the recorded call was made, with inputs that
 * do exactly what the recorded inputs did, and checks that it does exactly
 * what the recorded call did: the same operations on its inputs, in the same
 * order, with the same arguments, ending the same way. It returns what the
 * function returns, or throws what it throws; for a recorded call that
 * returned a promise, it returns a promise.
 *
 * Replay settles the promises the inputs gave the function, and calls back
 * what the function gave them, in the order the recording holds.
 *
 * @throws {ReplayError} At the first thing the function does differently.
 * @throws {HermeticError} When the function isn't hermetic.
 */
export function replay<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, recording: Recording): R {
  mustBeHermetic(fn);
  const player = new Player(recording);
  const self = player.decode(recording.this);
  const args = recording.args.map((arg) => player.decode(arg));
  let result: unknown;
  try {
    result = Reflect.apply(fn, self, args);
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    player.finish({ error: player.encode(error) }, "threw");
    throw error;
  }
  if (recording.outcome.async) return player.drive(result) as R;
  player.finish({ value: player.encode(result) }, "returned");
  return result as R;
}

function mustBeHermetic(fn: (...args: never[]) => unknown): void {
  const source = Function.prototype.toString.call(fn);
  const result = check(source);
  if (!result.hermetic) throw notHermetic(source, result.problems);
}

// Values -----------------------------------------------------------------

type Kind = "object" | "array" | "function" | "promise";

const WELL_KNOWN = new Map(
  (
    [
      "asyncIterator",
      "hasInstance",
      "isConcatSpreadable",
      "iterator",
      "match",
      "matchAll",
      "replace",
      "search",
      "species",
      "split",
      "toPrimitive",
      "toStringTag",
      "unscopables",
    ] as const
  ).map((name) => [Symbol[name], name]),
);

/** The standard errors, which cross as data: by name, message, cause, and their other properties. */
const ERRORS: Readonly<Record<string, ErrorConstructor>> = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const ERROR_NAMES = new Map<object, string>(Object.entries(ERRORS).map(([name, constructor]) => [constructor.prototype, name]));

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function kindOf(value: object): Kind {
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return "array";
  return value instanceof Promise ? "promise" : "object";
}

/**
 * Plain data: primitives other than symbols; arrays and plain objects of plain
 * data, whose properties are all enumerable data properties with string keys;
 * and the standard errors. `opaque` marks values that must not be looked
 * into, such as proxies.
 */
function isData(value: unknown, opaque: (value: object) => boolean, ancestors = new Set<object>()): boolean {
  if (!isObject(value)) return typeof value !== "symbol";
  if (typeof value === "function" || opaque(value) || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  const error = ERROR_NAMES.has(prototype);
  if (!error && (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)) return false;
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      if (array && key === "length") continue;
      if (error && (key === "stack" || key === "message")) continue;
      if (error && key === "cause") {
        if (!isData(Reflect.getOwnPropertyDescriptor(value, key)?.value, opaque, ancestors)) return false;
        continue;
      }
      if (array && String(Number(key) >>> 0) !== key) return false;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      if (!isData(descriptor.value, opaque, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function encodeData(value: unknown): Encoded {
  switch (typeof value) {
    case "undefined":
      return { $: "undefined" };
    case "bigint":
      return { $: "bigint", value: String(value) };
    case "number":
      if (Object.is(value, -0)) return { $: "number", value: "-0" };
      return Number.isFinite(value) ? value : { $: "number", value: String(value) };
    case "string":
    case "boolean":
      return value;
  }
  if (value === null) return null;
  if (Array.isArray(value)) return Array.from(value, encodeData);
  const props: Record<string, Encoded> = {};
  for (const [key, item] of Object.entries(value as object)) props[key] = encodeData(item);
  const name = ERROR_NAMES.get(Object.getPrototypeOf(value) as object);
  if (name) {
    const error = value as Error;
    const encoded: Record<string, Encoded> = { $: "error", name, message: String(error.message) };
    if (Object.hasOwn(error, "cause")) encoded.cause = encodeData(error.cause);
    if (Object.keys(props).length > 0) encoded.props = props;
    return encoded;
  }
  if (Object.getPrototypeOf(value) === null) return { $: "object", props, prototype: null };
  return Object.hasOwn(props, "$") ? { $: "object", props } : props;
}

/** A fresh copy of the data `encoded` stands for, or undefined when it stands for something else. */
function decodeData(encoded: Encoded): { value: unknown } | undefined {
  if (encoded === null || typeof encoded !== "object") return { value: encoded };
  if (Array.isArray(encoded)) {
    const items: unknown[] = [];
    for (const item of encoded) {
      const decoded = decodeData(item);
      if (!decoded) return undefined;
      items.push(decoded.value);
    }
    return { value: items };
  }
  const tagged = encoded as { readonly [key: string]: Encoded };
  const props = (source: { readonly [key: string]: Encoded }, target: Record<string, unknown>) => {
    for (const [key, item] of Object.entries(source)) {
      const decoded = decodeData(item);
      if (!decoded) return undefined;
      target[key] = decoded.value;
    }
    return { value: target as unknown };
  };
  switch (tagged.$) {
    case undefined:
      return props(tagged, {});
    case "undefined":
      return { value: undefined };
    case "number":
      return { value: tagged.value === "-0" ? -0 : Number(tagged.value) };
    case "bigint":
      return { value: BigInt(tagged.value as string) };
    case "object":
      return props(tagged.props as { readonly [key: string]: Encoded }, tagged.prototype === null ? Object.create(null) : {});
    case "error": {
      const error = new (ERRORS[tagged.name as string] ?? Error)(tagged.message as string);
      if ("cause" in tagged) {
        const cause = decodeData(tagged.cause as Encoded);
        if (!cause) return undefined;
        Object.defineProperty(error, "cause", { value: cause.value, writable: true, configurable: true });
      }
      return tagged.props === undefined ? { value: error } : props(tagged.props as { readonly [key: string]: Encoded }, error as never);
    }
    default:
      return undefined;
  }
}

/** Two encoded values are the same value. */
function same(a: Encoded | readonly Encoded[] | undefined, b: Encoded | readonly Encoded[] | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A crossing value: what the other side is given, and how the recording holds it. */
interface Crossing {
  readonly give: unknown;
  readonly encoded: Encoded;
}

/** Symbols by id: well-known ones by name, registered ones by key, and the rest by the order they appeared in. */
class Symbols {
  readonly #ids = new Map<symbol, number>();
  readonly #symbols = new Map<number, symbol>();

  encode(symbol: symbol): Encoded {
    const name = WELL_KNOWN.get(symbol);
    if (name) return { $: "symbol", name };
    const key = Symbol.keyFor(symbol);
    if (key !== undefined) return { $: "symbol", for: key };
    let id = this.#ids.get(symbol);
    if (id === undefined) {
      id = this.#ids.size;
      this.#ids.set(symbol, id);
    }
    return { $: "symbol", id, description: symbol.description ?? null };
  }

  decode(encoded: { readonly [key: string]: Encoded }): symbol {
    if (typeof encoded.name === "string") return Symbol[encoded.name as "iterator"];
    if (typeof encoded.for === "string") return Symbol.for(encoded.for);
    const id = encoded.id as number;
    let symbol = this.#symbols.get(id);
    if (!symbol) {
      symbol = Symbol(typeof encoded.description === "string" ? encoded.description : undefined);
      this.#symbols.set(id, symbol);
    }
    return symbol;
  }
}

/** An empty stand-in with the same kind as the value it stands for, so that a proxy of it behaves like one. */
function shadowOf(kind: Kind): object {
  if (kind === "function") return Function.prototype.bind.call(function () {}, null) as object;
  return kind === "array" ? [] : {};
}

/** A descriptor as a proxy may report it: a property its shadow doesn't have is configurable, whatever the real one is. */
function reportable(shadow: object, key: PropertyKey, descriptor: PropertyDescriptor): PropertyDescriptor {
  return { ...descriptor, configurable: Reflect.getOwnPropertyDescriptor(shadow, key)?.configurable ?? true };
}

/** A descriptor crossing to the other side: its flags as they are, and its value or accessors crossed. */
function crossDescriptor(descriptor: PropertyDescriptor | undefined, cross: (value: unknown) => Crossing): Crossing {
  if (!descriptor) return { give: undefined, encoded: { $: "undefined" } };
  const give: PropertyDescriptor = {};
  const encoded: Record<string, Encoded> = {};
  for (const flag of ["writable", "enumerable", "configurable"] as const) {
    if (flag in descriptor) encoded[flag] = give[flag] = descriptor[flag] === true;
  }
  for (const part of ["value", "get", "set"] as const) {
    if (!(part in descriptor)) continue;
    const crossing = cross(descriptor[part]);
    give[part] = crossing.give as never;
    encoded[part] = crossing.encoded;
  }
  return { give, encoded };
}

// Recording --------------------------------------------------------------

interface Draft {
  by: "fn" | "env";
  op: Operation;
  target: number;
  key?: Encoded;
  this?: Encoded;
  args?: Encoded[];
  result?: Result;
  during?: Draft[];
}

class Recorder {
  readonly events: Draft[] = [];
  readonly #lists: Draft[][] = [this.events];
  #open = true;
  readonly #symbols = new Symbols();
  // Inputs: values from outside the function, and the proxies it holds for them.
  readonly #inputIds = new Map<object, number>();
  readonly #inputGiven = new Map<object, object>();
  readonly #inputOf = new WeakMap<object, object>();
  // The function's own values given to its inputs, and the proxies they hold for them.
  readonly #ownIds = new Map<object, number>();
  readonly #ownGiven = new Map<object, object>();
  readonly #ownOf = new WeakMap<object, object>();

  close(): void {
    this.#open = false;
  }

  /** `this` is always an input, when it is an object, so that each read of it is recorded. */
  root(env: unknown): Crossing {
    return isObject(env) ? this.#input(env) : { give: env, encoded: encodeData(env) };
  }

  /** A value crossing from the inputs to the function. */
  toFn(value: unknown): Crossing {
    if (isObject(value)) {
      const own = this.#ownOf.get(value);
      if (own) return { give: own, encoded: { $: "own", id: this.#ownIds.get(own) ?? -1, kind: kindOf(own) } };
    }
    if (typeof value === "symbol") return { give: value, encoded: this.#symbols.encode(value) };
    if (isData(value, this.#opaque)) return { give: value, encoded: encodeData(value) };
    return this.#input(value as object);
  }

  /** A value crossing from the function to its inputs. */
  toEnv(value: unknown): Crossing {
    if (isObject(value)) {
      const input = this.#inputOf.get(value);
      if (input) return { give: input, encoded: { $: "input", id: this.#inputIds.get(input) ?? -1, kind: kindOf(input) } };
    }
    if (typeof value === "symbol") return { give: value, encoded: this.#symbols.encode(value) };
    if (isData(value, this.#opaque)) return { give: value, encoded: encodeData(value) };
    const own = value as object;
    let id = this.#ownIds.get(own);
    if (id === undefined) {
      id = this.#ownIds.size;
      this.#ownIds.set(own, id);
    }
    let given = this.#ownGiven.get(own);
    if (!given) {
      given = new Proxy(shadowOf(kindOf(own)), this.#handler(own, id, "env"));
      this.#ownGiven.set(own, given);
      this.#ownOf.set(given, own);
    }
    return { give: given, encoded: { $: "own", id, kind: kindOf(own) } };
  }

  readonly #opaque = (value: object): boolean => this.#inputOf.has(value) || this.#ownOf.has(value);

  #input(real: object): Crossing {
    let id = this.#inputIds.get(real);
    if (id === undefined) {
      id = this.#inputIds.size;
      this.#inputIds.set(real, id);
    }
    const kind = kindOf(real);
    let given = this.#inputGiven.get(real);
    if (!given) {
      // The function gets a promise that settles as the input's does, when the recording notes it.
      given =
        real instanceof Promise
          ? real.then(
              (value: unknown) => this.#settle(id, { value }),
              (error: unknown) => {
                throw this.#settle(id, { error });
              },
            )
          : new Proxy(shadowOf(kind), this.#handler(real, id, "fn"));
      this.#inputGiven.set(real, given);
      this.#inputOf.set(given, real);
    }
    return { give: given, encoded: { $: "input", id, kind } };
  }

  #settle(target: number, outcome: { value: unknown } | { error: unknown }): unknown {
    const crossing = this.toFn("value" in outcome ? outcome.value : outcome.error);
    const result = "value" in outcome ? { value: crossing.encoded } : { error: crossing.encoded };
    if (this.#open) this.#lists[this.#lists.length - 1]?.push({ by: "env", op: "settle", target, result });
    return crossing.give;
  }

  /** Runs one operation on the other side, and records it with what that side did during it. */
  #run(event: Draft, operate: () => unknown, back: (value: unknown) => Crossing): unknown {
    const open = this.#open;
    const during: Draft[] = [];
    if (open) {
      this.#lists[this.#lists.length - 1]?.push(event);
      this.#lists.push(during);
    }
    try {
      const crossing = back(operate());
      event.result = { value: crossing.encoded };
      return crossing.give;
    } catch (error) {
      const crossing = back(error);
      event.result = { error: crossing.encoded };
      throw crossing.give;
    } finally {
      if (open) {
        this.#lists.pop();
        if (during.length > 0) event.during = during;
      }
    }
  }

  /**
   * Traps that record each operation on `real` and run it there. With `by:
   * "fn"`, the function acts on an input; with `by: "env"`, an input acts on
   * a value of the function's. Values going to `real` cross one way, and what
   * comes back crosses the other.
   */
  #handler(real: object, target: number, by: "fn" | "env"): ProxyHandler<object> {
    const there = by === "fn" ? (value: unknown) => this.toEnv(value) : (value: unknown) => this.toFn(value);
    const back = by === "fn" ? (value: unknown) => this.toFn(value) : (value: unknown) => this.toEnv(value);
    const key = (name: PropertyKey): Encoded => (typeof name === "symbol" ? this.#symbols.encode(name) : name);
    const run = (event: Omit<Draft, "by" | "target">, operate: () => unknown, crossing = back) =>
      this.#run({ by, target, ...event }, operate, crossing);
    const data = (value: unknown): Crossing => ({ give: value, encoded: value as Encoded });
    return {
      get: (_, name, receiver) => run({ op: "get", key: key(name) }, () => Reflect.get(real, name, there(receiver).give)),
      set: (_, name, value, receiver) => {
        const sent = there(value);
        return run({ op: "set", key: key(name), args: [sent.encoded] }, () => Reflect.set(real, name, sent.give, there(receiver).give), data) as boolean;
      },
      has: (_, name) => run({ op: "has", key: key(name) }, () => Reflect.has(real, name), data) as boolean,
      deleteProperty: (_, name) => run({ op: "delete", key: key(name) }, () => Reflect.deleteProperty(real, name), data) as boolean,
      ownKeys: () =>
        run({ op: "keys" }, () => Reflect.ownKeys(real), (keys) => ({ give: keys, encoded: (keys as PropertyKey[]).map(key) })) as (
          | string
          | symbol
        )[],
      getOwnPropertyDescriptor: (shadow, name) =>
        run(
          { op: "describe", key: key(name) },
          () => Reflect.getOwnPropertyDescriptor(real, name),
          (value) => crossDescriptor(value === undefined ? undefined : reportable(shadow, name, value as PropertyDescriptor), back),
        ) as PropertyDescriptor | undefined,
      defineProperty: (_, name, descriptor) => {
        if (descriptor.configurable === false) throw new TypeError("record can't follow a non-configurable property defined on another side.");
        const sent = crossDescriptor(descriptor, there);
        return run({ op: "define", key: key(name), args: [sent.encoded] }, () => Reflect.defineProperty(real, name, sent.give as PropertyDescriptor), data) as boolean;
      },
      getPrototypeOf: () => run({ op: "prototype" }, () => Reflect.getPrototypeOf(real)) as object | null,
      apply: (_, self, args: unknown[]) => {
        const sentThis = there(self);
        const sent = args.map(there);
        return run({ op: "call", this: sentThis.encoded, args: sent.map((arg) => arg.encoded) }, () =>
          Reflect.apply(real as (...args: unknown[]) => unknown, sentThis.give, sent.map((arg) => arg.give)),
        );
      },
      construct: (_, args: unknown[], newTarget) => {
        const sent = args.map(there);
        return run({ op: "new", args: sent.map((arg) => arg.encoded) }, () =>
          Reflect.construct(real as new (...args: unknown[]) => object, sent.map((arg) => arg.give), there(newTarget).give as new () => object),
        ) as object;
      },
      isExtensible: (shadow) => Reflect.isExtensible(shadow),
      preventExtensions: () => {
        throw new TypeError("record can't follow making a value from another side non-extensible.");
      },
      setPrototypeOf: () => {
        throw new TypeError("record can't follow changing the prototype of a value from another side.");
      },
    };
  }
}

// Replaying --------------------------------------------------------------

interface Cursor {
  readonly events: readonly Event[];
  index: number;
}

class Player {
  readonly #recording: Recording;
  /** The first divergence, which stands even if the function catches it. */
  #failure: ReplayError | undefined;
  readonly #cursors: Cursor[];
  readonly #symbols = new Symbols();
  // Inputs by id: stand-ins that do what the recorded inputs did, and promises the recording settles.
  readonly #inputs = new Map<number, object>();
  readonly #inputIds = new Map<object, number>();
  readonly #promises = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #labels = new Map<number, string>();
  // The function's own values, by the id the recording gives them.
  readonly #owns: object[] = [];
  readonly #ownIds = new Map<object, number>();

  constructor(recording: Recording) {
    this.#recording = recording;
    this.#cursors = [{ events: recording.events, index: 0 }];
    this.#labels.set(0, "this");
    recording.args.forEach((arg, index) => {
      if (isObject(arg) && !Array.isArray(arg) && (arg as { $?: Encoded }).$ === "input") {
        const id = (arg as { id?: Encoded }).id;
        if (typeof id === "number" && !this.#labels.has(id)) this.#labels.set(id, `arguments[${index}]`);
      }
    });
  }

  /** A value from the recording, as the function receives it. */
  decode(encoded: Encoded): unknown {
    const data = decodeData(encoded);
    if (data) return data.value;
    const tagged = encoded as { readonly [key: string]: Encoded };
    switch (tagged.$) {
      case "symbol":
        return this.#symbols.decode(tagged);
      case "input":
        return this.#input(tagged.id as number, tagged.kind as Kind);
      case "own": {
        const own = this.#owns[tagged.id as number];
        if (!own) throw this.#fail(`The recording refers to the function's value #${String(tagged.id)}, which it hasn't given out.`);
        return own;
      }
      default:
        throw this.#fail(`The recording holds a value replay can't read: ${JSON.stringify(encoded)}.`);
    }
  }

  /** A value the function gives out, as the recording would hold it. */
  encode(value: unknown): Encoded {
    if (isObject(value)) {
      const input = this.#inputIds.get(value);
      if (input !== undefined) return { $: "input", id: input, kind: this.#kindOfInput(value) };
    }
    if (typeof value === "symbol") return this.#symbols.encode(value);
    if (isData(value, (object) => this.#inputIds.has(object))) return encodeData(value);
    const own = value as object;
    let id = this.#ownIds.get(own);
    if (id === undefined) {
      id = this.#owns.length;
      this.#owns.push(own);
      this.#ownIds.set(own, id);
    }
    return { $: "own", id, kind: kindOf(own) };
  }

  /** Checks a finished synchronous call: nothing left in the recording, and the same ending. */
  finish(outcome: Result, how: string): void {
    if (this.#failure) throw this.#failure;
    const cursor = this.#cursors[0];
    const next = cursor?.events[cursor.index];
    if (next) throw this.#fail(`The function ${how} before ${this.#describe(next)}, which the recorded call did next.`);
    this.#compareOutcome(outcome);
  }

  #fail(message: string): ReplayError {
    this.#failure ??= new ReplayError(message);
    return this.#failure;
  }

  /** Plays the rest of an asynchronous call: settles its inputs' promises and calls it back in the recorded order. */
  async drive(result: unknown): Promise<unknown> {
    if (!(result instanceof Promise)) throw this.#fail("The recorded call returned a promise, and the replayed call didn't.");
    let settled: { value: unknown } | { error: unknown } | undefined;
    result.then(
      (value: unknown) => (settled = { value }),
      (error: unknown) => (settled = { error }),
    );
    const root = this.#cursors[0] as Cursor;
    while (root.index < root.events.length) {
      if (this.#failure) throw this.#failure;
      const next = root.events[root.index] as Event;
      if (next.by === "env") {
        root.index++;
        this.#perform(next);
        continue;
      }
      const before = root.index;
      await nextTask();
      if (this.#failure) throw this.#failure;
      if (root.index === before) throw this.#fail(`The function stopped before ${this.#describe(next)}, which the recorded call did next.`);
    }
    await nextTask();
    if (this.#failure) throw this.#failure;
    if (!settled) throw this.#fail("The function's promise hadn't settled where the recording ends.");
    if ("value" in settled) {
      this.#compareOutcome({ value: this.encode(settled.value) });
      return settled.value;
    }
    this.#compareOutcome({ error: this.encode(settled.error) });
    throw settled.error;
  }

  #compareOutcome(outcome: Result): void {
    const recorded = this.#recording.outcome;
    const ended = (result: Result) => ("value" in result ? `returned ${short(result.value)}` : `threw ${short(result.error)}`);
    const plain = "value" in recorded ? { value: recorded.value } : { error: recorded.error };
    if (!same(outcome as unknown as Encoded, plain as unknown as Encoded)) {
      throw this.#fail(`The function ${ended(outcome)}, and the recorded call ${ended(plain)}.`);
    }
  }

  /** An input's kind, as the recording gave it: asking the stand-in would be an operation on it. */
  #kindOfInput(value: object): Kind {
    return this.#inputKinds.get(value) ?? "object";
  }

  readonly #inputKinds = new WeakMap<object, Kind>();

  #input(id: number, kind: Kind): object {
    const existing = this.#inputs.get(id);
    if (existing) return existing;
    let input: object;
    if (kind === "promise") {
      input = new Promise((resolve, reject) => this.#promises.set(id, { resolve, reject }));
    } else {
      input = new Proxy(shadowOf(kind), this.#handler(id));
    }
    this.#inputs.set(id, input);
    this.#inputIds.set(input, id);
    this.#inputKinds.set(input, kind);
    return input;
  }

  /** Traps that check each operation against the recording, and do what the recorded input did. */
  #handler(target: number): ProxyHandler<object> {
    const key = (name: PropertyKey): Encoded => (typeof name === "symbol" ? this.#symbols.encode(name) : name);
    const act = (expected: Omit<Event, "by" | "target" | "result" | "during">) => this.#act({ by: "fn", target, ...expected });
    return {
      get: (_, name) => act({ op: "get", key: key(name) }),
      set: (_, name, value) => act({ op: "set", key: key(name), args: [this.encode(value)] }) as boolean,
      has: (_, name) => act({ op: "has", key: key(name) }) as boolean,
      deleteProperty: (_, name) => act({ op: "delete", key: key(name) }) as boolean,
      ownKeys: () => this.#act({ by: "fn", target, op: "keys" }, (encoded) => (encoded as Encoded[]).map((name) => this.#key(name))) as (string | symbol)[],
      getOwnPropertyDescriptor: (shadow, name) =>
        this.#act({ by: "fn", target, op: "describe", key: key(name) }, (encoded) => {
          const parts = encoded as { readonly [part: string]: Encoded };
          if (parts.$ === "undefined") return undefined;
          const descriptor: PropertyDescriptor = {};
          for (const flag of ["writable", "enumerable", "configurable"] as const) if (flag in parts) descriptor[flag] = parts[flag] === true;
          for (const part of ["value", "get", "set"] as const) if (part in parts) descriptor[part] = this.decode(parts[part] as Encoded) as never;
          return reportable(shadow, name, descriptor);
        }) as PropertyDescriptor | undefined,
      defineProperty: (_, name, descriptor) => {
        const sent = crossDescriptor(descriptor, (value) => ({ give: value, encoded: this.encode(value) }));
        return act({ op: "define", key: key(name), args: [sent.encoded] }) as boolean;
      },
      getPrototypeOf: () => act({ op: "prototype" }) as object | null,
      apply: (_, self, args: unknown[]) => act({ op: "call", this: this.encode(self), args: args.map((arg) => this.encode(arg)) }),
      construct: (_, args: unknown[]) => act({ op: "new", args: args.map((arg) => this.encode(arg)) }) as object,
      isExtensible: (shadow) => Reflect.isExtensible(shadow),
      preventExtensions: () => {
        throw new TypeError("replay can't follow making an input non-extensible.");
      },
      setPrototypeOf: () => {
        throw new TypeError("replay can't follow changing the prototype of an input.");
      },
    };
  }

  #key(encoded: Encoded): string | symbol {
    return typeof encoded === "string" ? encoded : this.#symbols.decode(encoded as { readonly [key: string]: Encoded });
  }

  /**
   * The function did `actual` to an input: it must be what the recording
   * holds next. Does what the other side did during it, then ends it as the
   * recorded one ended.
   */
  #act(actual: Omit<Event, "result" | "during">, decode = (encoded: Encoded) => this.decode(encoded)): unknown {
    const cursor = this.#cursors[this.#cursors.length - 1] as Cursor;
    const event = cursor.events[cursor.index];
    const matches =
      event?.by === actual.by &&
      event.op === actual.op &&
      event.target === actual.target &&
      same(event.key, actual.key) &&
      same(event.this, actual.this) &&
      same(event.args, actual.args);
    if (this.#failure) throw this.#failure;
    if (!event || !matches) {
      throw this.#fail(`The function ${this.#describe(actual)}, and the recorded call ${event ? this.#describe(event) : "did nothing more"} there.`);
    }
    cursor.index++;
    for (const during of event.during ?? []) this.#perform(during);
    const result = event.result;
    if (!result) throw this.#fail(`The recording doesn't say how ${this.#describe(event)} ended.`);
    if ("error" in result) throw this.decode(result.error);
    const value = decode(result.value);
    this.#label(event, result.value);
    return value;
  }

  /** Does what the other side did to the function: calls it back, reads its values, or settles a promise. */
  #perform(event: Event): void {
    if (event.by !== "env") throw this.#fail(`The recording has the function ${this.#describe(event)} where the other side acted.`);
    const result = event.result;
    if (event.op === "settle") {
      this.#input(event.target, "promise");
      const settle = this.#promises.get(event.target);
      if (!settle || !result) throw this.#fail(`The recording settles input #${event.target}, which isn't a promise it gave.`);
      if ("error" in result) settle.reject(this.decode(result.error));
      else settle.resolve(this.decode(result.value));
      return;
    }
    const own = this.#owns[event.target];
    if (!own) throw this.#fail(`The recording acts on the function's value #${event.target}, which it hasn't given out.`);
    const cursor: Cursor = { events: event.during ?? [], index: 0 };
    this.#cursors.push(cursor);
    let outcome: Result;
    try {
      outcome = { value: this.#operate(own, event) };
    } catch (error) {
      if (error instanceof ReplayError) throw error;
      outcome = { error: this.encode(error) };
    } finally {
      this.#cursors.pop();
    }
    if (this.#failure) throw this.#failure;
    const next = cursor.events[cursor.index];
    if (next) throw this.#fail(`The function stopped before ${this.#describe(next)}, which the recorded call did next.`);
    if (!same(outcome as Encoded, result as Encoded | undefined)) {
      throw this.#fail(`When ${this.#describe(event)}, the function's value gave ${short(outcome as Encoded)}, and in the recorded call ${short((result ?? null) as Encoded)}.`);
    }
  }

  /** Redoes an operation on one of the function's own values, and returns its result as the recording holds it. */
  #operate(own: object, event: Event): Encoded {
    const name = event.key === undefined ? "" : this.#key(event.key);
    const args = (event.args ?? []).map((arg) => this.decode(arg));
    const encode = (value: unknown) => this.encode(value);
    switch (event.op) {
      case "get":
        return encode(Reflect.get(own, name));
      case "set":
        return Reflect.set(own, name, args[0]);
      case "has":
        return Reflect.has(own, name);
      case "delete":
        return Reflect.deleteProperty(own, name);
      case "keys":
        return Reflect.ownKeys(own).map((key) => (typeof key === "symbol" ? this.#symbols.encode(key) : key));
      case "describe": {
        const descriptor = Reflect.getOwnPropertyDescriptor(own, name);
        const reported = descriptor && reportable(shadowOf(kindOf(own)), name, descriptor);
        return crossDescriptor(reported, (value) => ({ give: value, encoded: encode(value) })).encoded;
      }
      case "define": {
        const parts = (event.args?.[0] ?? {}) as { readonly [part: string]: Encoded };
        const descriptor: PropertyDescriptor = {};
        for (const flag of ["writable", "enumerable", "configurable"] as const) if (flag in parts) descriptor[flag] = parts[flag] === true;
        for (const part of ["value", "get", "set"] as const) if (part in parts) descriptor[part] = this.decode(parts[part] as Encoded) as never;
        return Reflect.defineProperty(own, name, descriptor);
      }
      case "prototype":
        return encode(Reflect.getPrototypeOf(own));
      case "call":
        return encode(Reflect.apply(own as (...args: unknown[]) => unknown, this.decode(event.this ?? { $: "undefined" }), args));
      case "new":
        return encode(Reflect.construct(own as new (...args: unknown[]) => object, args));
      default:
        throw this.#fail(`Replay can't redo ${this.#describe(event)}.`);
    }
  }

  /** Names a new input after how the function reached it, for messages. */
  #label(event: Event, value: Encoded): void {
    const tagged = value as { readonly [key: string]: Encoded } | null;
    if (!isObject(tagged) || Array.isArray(tagged) || tagged.$ !== "input" || typeof tagged.id !== "number" || this.#labels.has(tagged.id)) return;
    const base = this.#name(event.target);
    const label =
      event.op === "get"
        ? `${base}${typeof event.key === "string" && /^[A-Za-z_$][\w$]*$/.test(event.key) ? `.${event.key}` : `[${short(event.key ?? null)}]`}`
        : event.op === "call"
          ? `${base}(…)`
          : event.op === "new"
            ? `new ${base}(…)`
            : `a value from ${base}`;
    this.#labels.set(tagged.id, label);
  }

  #name(input: number): string {
    return this.#labels.get(input) ?? `input #${input}`;
  }

  #describe(event: Omit<Event, "result" | "during">): string {
    const target = event.by === "fn" ? this.#name(event.target) : `its value #${event.target}`;
    const key = event.key === undefined ? "" : typeof event.key === "string" ? event.key : short(event.key);
    const args = (event.args ?? []).map((arg) => short(arg)).join(", ");
    const subject = event.by === "fn" ? "" : "the other side ";
    switch (event.op) {
      case "get":
        return `${subject}read ${target}.${key}`;
      case "set":
        return `${subject}set ${target}.${key} to ${args}`;
      case "has":
        return `${subject}checked for ${key} in ${target}`;
      case "delete":
        return `${subject}deleted ${target}.${key}`;
      case "keys":
        return `${subject}listed the keys of ${target}`;
      case "describe":
        return `${subject}described ${target}.${key}`;
      case "define":
        return `${subject}defined ${target}.${key}`;
      case "prototype":
        return `${subject}read the prototype of ${target}`;
      case "call":
        return `${subject}called ${target}(${args})`;
      case "new":
        return `${subject}constructed new ${target}(${args})`;
      case "settle":
        return `the other side settled ${this.#name(event.target)}`;
    }
  }
}

function short(encoded: Encoded): string {
  const text = JSON.stringify(encoded) ?? "undefined";
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The host's timer, which ECMAScript leaves to the host; every host this runs on has one. */
interface Timers {
  setTimeout(run: () => void, ms: number): unknown;
}

/** Waits for everything already queued to run, promise reactions included. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => (globalThis as unknown as Timers).setTimeout(resolve, 0));
}
