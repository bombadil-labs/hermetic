import { type Recording, record, ReplayError, replay } from "@bombadil/hermetic/record";
import { describe, expect, it } from "vitest";
import { HermeticError, type Intrinsics, intrinsics } from "../src/index.ts";

interface Pricing {
  readonly rate: number;
  readonly clamp: (n: number) => number;
}

function price(this: Pricing, total: number): number {
  "use hermetic";
  return this.clamp(total * (1 - this.rate));
}

/** Records one call, and returns its result and its recording. */
function once<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, env: NoInfer<T>, ...args: A): { result: R; recording: Recording } {
  const recordings: Recording[] = [];
  const result = record(fn, env, (recording) => recordings.push(recording))(...args);
  const [recording] = recordings;
  if (!recording) throw new Error("no recording");
  return { result, recording };
}

describe("record", () => {
  const env: Pricing = { rate: 0.25, clamp: (n) => Math.min(n, 60) };

  it("runs the function as it would run bound to its environment", () => {
    const recordings: Recording[] = [];
    const recorded = record(price, env, (recording) => recordings.push(recording));
    expect(recorded(100)).toBe(60);
    expect(recorded(40)).toBe(30);
    expect(recordings).toHaveLength(2);
  });

  it("holds everything the call did with its inputs, as JSON", () => {
    const { recording } = once(price, env, 40);
    expect(recording).toEqual({
      this: { $: "input", id: 0, kind: "object" },
      args: [40],
      events: [
        { by: "fn", op: "get", target: 0, key: "clamp", result: { value: { $: "input", id: 1, kind: "function" } } },
        { by: "fn", op: "get", target: 0, key: "rate", result: { value: 0.25 } },
        { by: "fn", op: "call", target: 1, this: { $: "input", id: 0, kind: "object" }, args: [30], result: { value: 30 } },
      ],
      outcome: { value: 30 },
    });
    expect(JSON.parse(JSON.stringify(recording))).toEqual(recording);
  });

  it("copies plain data, including values JSON can't hold", () => {
    function describe(this: { readonly facts: unknown }): unknown {
      "use hermetic";
      return this.facts;
    }
    const facts = { list: [1, undefined, Number.NaN, -0, 2n ** 64n], nested: { $: "not a tag" }, bare: Object.assign(Object.create(null), { a: 1 }) };
    const { recording } = once(describe, { facts });
    const copy = replay(describe, JSON.parse(JSON.stringify(recording)) as Recording) as typeof facts;
    expect(copy).toEqual(facts);
    expect(copy).not.toBe(facts);
    expect(Object.is(copy.list[3], -0)).toBe(true);
    expect(Object.getPrototypeOf(copy.bare)).toBeNull();
  });

  it("records through a frozen environment, like the one inject binds", () => {
    const frozen = Object.freeze({ ...env });
    const { result, recording } = once(price, frozen, 100);
    expect(result).toBe(60);
    expect(replay(price, recording)).toBe(60);
  });

  it("refuses a function that isn't hermetic", () => {
    const rate = 0.5;
    const leaky = (total: number) => total * rate;
    expect(() => record(leaky, undefined, () => {})).toThrow(HermeticError);
    expect(() => replay(leaky, { this: null, args: [1], events: [], outcome: { value: 0.5 } })).toThrow(HermeticError);
  });

  it("stops recording when the call ends", () => {
    function makeCounter(this: { readonly start: () => number }): () => number {
      "use hermetic";
      let count = this.start();
      return () => ++count;
    }
    const recordings: Recording[] = [];
    const counter = record(makeCounter, { start: () => 10 }, (recording) => recordings.push(recording))();
    expect(counter()).toBe(11);
    expect(counter()).toBe(12);
    expect(recordings[0]?.events).toHaveLength(2);
    expect(recordings[0]?.outcome).toEqual({ value: { $: "own", id: 0, kind: "function" } });
  });
});

describe("replay", () => {
  const env: Pricing = { rate: 0.25, clamp: (n) => Math.min(n, 60) };

  it("runs the function against what the recorded inputs did, and returns its result", () => {
    const { recording } = once(price, env, 100);
    expect(replay(price, recording)).toBe(60);
  });

  it("needs nothing but the recording, which can be stored as JSON", () => {
    const { recording } = once(price, env, 40);
    const stored = JSON.stringify(recording);
    expect(replay(price, JSON.parse(stored) as Recording)).toBe(30);
  });

  it("reports the first thing the function does differently", () => {
    const { recording } = once(price, env, 100);
    function priceTwice(this: Pricing, total: number): number {
      "use hermetic";
      const clamped = this.clamp(total * (1 - this.rate));
      return this.clamp(clamped);
    }
    function priceNone(this: Pricing, total: number): number {
      "use hermetic";
      return total * 0.6;
    }
    function priceFirst(this: Pricing, total: number): number {
      "use hermetic";
      const rate = this.rate;
      return this.clamp(total * (1 - rate));
    }
    function priceAt(this: Pricing, total: number): number {
      "use hermetic";
      return this.clamp(total * (0.5 - this.rate));
    }
    expect(() => replay(priceTwice, recording)).toThrow(new ReplayError("The function read this.clamp, and the recorded call did nothing more there."));
    expect(() => replay(priceNone, recording)).toThrow(new ReplayError("The function returned before read this.clamp, which the recorded call did next."));
    expect(() => replay(priceFirst, recording)).toThrow(new ReplayError("The function read this.rate, and the recorded call read this.clamp there."));
    expect(() => replay(priceAt, recording)).toThrow(new ReplayError("The function called this.clamp(25), and the recorded call called this.clamp(75) there."));
  });

  it("reports a divergence even when the function catches it", () => {
    const { recording } = once(price, env, 100);
    function careless(this: Pricing, total: number): number {
      "use hermetic";
      try {
        return this.clamp(total);
      } catch {
        return -1;
      }
    }
    expect(() => replay(careless, recording)).toThrow(ReplayError);
  });

  it("reports a different ending", () => {
    function half(this: { readonly n: number }): number {
      "use hermetic";
      return this.n / 2;
    }
    const { recording } = once(half, { n: 8 });
    const tampered: Recording = { ...recording, outcome: { value: 5 } };
    expect(() => replay(half, tampered)).toThrow(new ReplayError("The function returned 4, and the recorded call returned 5."));
  });

  it("throws what the recorded call threw, as the inputs threw it", () => {
    function strict(this: { readonly parse: (text: string) => number }, text: string): number {
      "use hermetic";
      return this.parse(text);
    }
    const parse = (text: string) => {
      if (!/^\d+$/.test(text)) throw new RangeError(`not a number: ${text}`);
      return Number(text);
    };
    const recordings: Recording[] = [];
    const recorded = record(strict, { parse }, (recording) => recordings.push(recording));
    expect(() => recorded("x")).toThrow(RangeError);
    const [recording] = recordings;
    if (!recording) throw new Error("no recording");
    let replayed: unknown;
    try {
      replay(strict, recording);
    } catch (error) {
      replayed = error;
    }
    expect(replayed).toBeInstanceOf(RangeError);
    expect((replayed as RangeError).message).toBe("not a number: x");
    expect(recording.outcome).toEqual({ error: { $: "error", name: "RangeError", message: "not a number: x" } });
  });

  it("carries an error's cause and its own properties, and instanceof through this still works", () => {
    function read(this: { readonly open: (path: string) => string; readonly Error: ErrorConstructor }, path: string): string {
      "use hermetic";
      try {
        return this.open(path);
      } catch (error) {
        return error instanceof this.Error ? `${(error as Error & { code: string }).code}: ${(error as Error).cause as string}` : "unknown";
      }
    }
    const open = (path: string) => {
      throw Object.assign(new Error(`can't open ${path}`, { cause: "missing" }), { code: "ENOENT" });
    };
    const { result, recording } = once(read, { open, Error }, "/tmp/x");
    expect(result).toBe("ENOENT: missing");
    expect(replay(read, JSON.parse(JSON.stringify(recording)) as Recording)).toBe("ENOENT: missing");
  });
});

describe("record and replay through built-ins, objects and callbacks", () => {
  const realm = { ...intrinsics(globalThis), Date };

  it("follows built-ins passed in through this", () => {
    function stamp(this: Pick<Intrinsics, "Math" | "JSON"> & { readonly Date: DateConstructor }, values: number[]): string {
      "use hermetic";
      const when = new this.Date(0).toISOString();
      return this.JSON.stringify({ when, max: this.Math.max(...values) });
    }
    const { result, recording } = once(stamp, realm, [3, 9, 4]);
    expect(result).toBe('{"when":"1970-01-01T00:00:00.000Z","max":9}');
    expect(replay(stamp, JSON.parse(JSON.stringify(recording)) as Recording)).toBe(result);
  });

  it("keeps an input's identity within a call", () => {
    function same(this: { readonly service: object }): boolean {
      "use hermetic";
      return this.service === this.service;
    }
    const { result, recording } = once(same, { service: { run: () => 1 } });
    expect(result).toBe(true);
    expect(replay(same, recording)).toBe(true);
  });

  it("records callbacks the environment calls during a call, and replays them", () => {
    function total(this: { readonly each: (items: readonly number[], visit: (item: number) => void) => void }, items: readonly number[]): number {
      "use hermetic";
      let sum = 0;
      this.each(items, (item) => {
        sum += item;
      });
      return sum;
    }
    const each = (items: readonly number[], visit: (item: number) => void) => {
      for (const item of items) visit(item);
    };
    const { result, recording } = once(total, { each }, [1, 2, 3]);
    expect(result).toBe(6);
    const [call] = recording.events.filter((event) => event.op === "call");
    expect(call?.during?.map((event) => [event.by, event.op, event.args])).toEqual([
      ["env", "call", [1]],
      ["env", "call", [2]],
      ["env", "call", [3]],
    ]);
    expect(replay(total, JSON.parse(JSON.stringify(recording)) as Recording)).toBe(6);
  });

  it("follows reads of keys and descriptors, as spreading and Object.keys do", () => {
    function listing(this: { readonly config: { readonly name: string; readonly run: () => void }; readonly Object: ObjectConstructor }): string[] {
      "use hermetic";
      const copy = { ...this.config };
      return this.Object.keys(copy);
    }
    const { result, recording } = once(listing, { config: { name: "x", run: () => {} }, Object });
    expect(result).toEqual(["name", "run"]);
    expect(replay(listing, recording)).toEqual(["name", "run"]);
  });
});

describe("record and replay of asynchronous calls", () => {
  interface Users {
    readonly fetchUser: (id: number) => Promise<{ readonly name: string }>;
    readonly log: (line: string) => void;
  }

  async function greet(this: Users, id: number): Promise<string> {
    "use hermetic";
    const user = await this.fetchUser(id);
    this.log(`greeted ${user.name}`);
    return `Hello, ${user.name}!`;
  }

  const env: Users = {
    fetchUser: async (id) => ({ name: id === 1 ? "Ada" : "Grace" }),
    log: () => {},
  };

  it("records how each promise from the inputs settled, and how the call's own promise did", async () => {
    const recordings: Recording[] = [];
    expect(await record(greet, env, (recording) => recordings.push(recording))(1)).toBe("Hello, Ada!");
    const [recording] = recordings;
    expect(recording?.outcome).toEqual({ value: "Hello, Ada!", async: true });
    expect(recording?.events.map((event) => [event.by, event.op])).toEqual([
      ["fn", "get"],
      ["fn", "call"],
      ["env", "settle"],
      ["fn", "get"],
      ["fn", "call"],
    ]);
  });

  it("settles the promises in the recorded order when it replays", async () => {
    const recordings: Recording[] = [];
    await record(greet, env, (recording) => recordings.push(recording))(2);
    const [recording] = recordings;
    if (!recording) throw new Error("no recording");
    await expect(replay(greet, JSON.parse(JSON.stringify(recording)) as Recording)).resolves.toBe("Hello, Grace!");
  });

  it("replays callbacks the environment calls later, like a timer", async () => {
    async function later(this: { readonly Promise: PromiseConstructor; readonly setTimeout: (run: () => void, ms: number) => unknown }): Promise<string> {
      "use hermetic";
      await new this.Promise<void>((resolve) => this.setTimeout(resolve, 5));
      return "done";
    }
    const recordings: Recording[] = [];
    const recorded = record(later, { Promise, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms) }, (recording) => recordings.push(recording));
    expect(await recorded()).toBe("done");
    const [recording] = recordings;
    if (!recording) throw new Error("no recording");
    await expect(replay(later, JSON.parse(JSON.stringify(recording)) as Recording)).resolves.toBe("done");
  });

  it("replays a rejected promise", async () => {
    async function greetOrNot(this: Users, id: number): Promise<string> {
      "use hermetic";
      try {
        const user = await this.fetchUser(id);
        return `Hello, ${user.name}!`;
      } catch (error) {
        return `No one to greet: ${(error as Error).message}`;
      }
    }
    const failing: Users = { ...env, fetchUser: async (id) => Promise.reject(new TypeError(`no user ${id}`)) };
    const recordings: Recording[] = [];
    expect(await record(greetOrNot, failing, (recording) => recordings.push(recording))(7)).toBe("No one to greet: no user 7");
    const [recording] = recordings;
    if (!recording) throw new Error("no recording");
    await expect(replay(greetOrNot, JSON.parse(JSON.stringify(recording)) as Recording)).resolves.toBe("No one to greet: no user 7");
  });

  it("reports an asynchronous divergence", async () => {
    const recordings: Recording[] = [];
    await record(greet, env, (recording) => recordings.push(recording))(1);
    const [recording] = recordings;
    if (!recording) throw new Error("no recording");
    async function greetQuietly(this: Users, id: number): Promise<string> {
      "use hermetic";
      const user = await this.fetchUser(id);
      return `Hello, ${user.name}!`;
    }
    await expect(replay(greetQuietly, recording)).rejects.toThrow(new ReplayError('The function stopped before read this.log, which the recorded call did next.'));
  });
});
