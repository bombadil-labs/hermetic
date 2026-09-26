import { check } from "./check.ts";
import { notHermetic } from "./confine.ts";

/** One function's examples, as a test: `run` resolves when they all hold, and rejects at the first that doesn't. */
export interface Doctest {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface DoctestOptions {
  /** Names the examples may use besides the function itself, such as the values they bind it to. */
  readonly scope?: Readonly<Record<string, unknown>>;
}

/** Thrown by a doctest whose example doesn't hold. */
export class DoctestError extends Error {
  override name = "DoctestError";
}

/**
 * The examples in the JSDoc of a module's hermetic functions, as tests. Each
 * `@example` of an exported function marked hermetic becomes one test, which
 * runs the example twice: with the function the module exports, and with a
 * copy made from its source alone, `new Function("return " + fn.toString())()`.
 * A hermetic function's source is all of its behavior, so both must pass.
 *
 * An example is JavaScript. A line that ends in `// => value` checks that the
 * code before the comment evaluates to `value`, compared by structure; one
 * that ends in `// throws`, `// throws TypeError` or `// throws TypeError:
 * message` checks that it throws such an error. Other lines run as they are,
 * and may use `await`.
 *
 * `module` is the module's namespace, and `source` its source text, where the
 * JSDoc is. They are separate because a function's JSDoc isn't part of its
 * `toString()`.
 */
export function doctests(module: Readonly<Record<string, unknown>>, source: string, options: DoctestOptions = {}): Doctest[] {
  const tests: Doctest[] = [];
  for (const { name, doc } of documented(source)) {
    const fn = module[name];
    if (typeof fn !== "function") continue;
    const examples = examplesIn(doc);
    if (examples.length === 0) continue;
    const text = Function.prototype.toString.call(fn);
    const result = check(text);
    if (!result.marked && !/(^|\s)@hermetic\b/m.test(doc)) continue;
    examples.forEach((example, index) => {
      const label = example.caption ?? (examples.length > 1 ? `example ${index + 1}` : "example");
      tests.push({
        name: `${name}: ${label}`,
        run: async () => {
          if (!result.hermetic) throw notHermetic(text, result.problems);
          await runExample(example, name, fn, options.scope ?? {}, "as exported");
          await runExample(example, name, relocate(text), options.scope ?? {}, "rebuilt from its source");
        },
      });
    });
  }
  return tests;
}

interface Example {
  readonly caption: string | undefined;
  readonly lines: readonly string[];
}

/** Each JSDoc comment in `source` that comes right before a named function or variable, with that name. */
function documented(source: string): { name: string; doc: string }[] {
  const declaration =
    /\/\*\*([\s\S]*?)\*\/\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/g;
  return [...source.matchAll(declaration)].map((match) => ({
    name: match[2] ?? match[3] ?? "",
    doc: (match[1] ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\* ?/, ""))
      .join("\n"),
  }));
}

/** The `@example` blocks of a JSDoc comment, each up to the next tag. */
function examplesIn(doc: string): Example[] {
  const examples: Example[] = [];
  let current: string[] | undefined;
  let caption: string | undefined;
  const finish = () => {
    if (current && current.some((line) => line.trim() !== "")) examples.push({ caption, lines: current });
    current = undefined;
  };
  for (const line of doc.split("\n")) {
    const tag = /^\s*@(\w+)\s*(.*)$/.exec(line);
    if (tag) {
      finish();
      if (tag[1] === "example") {
        const captioned = /^<caption>([\s\S]*?)<\/caption>\s*(.*)$/.exec(tag[2] ?? "");
        caption = captioned?.[1]?.trim();
        current = [];
        const rest = captioned ? (captioned[2] ?? "") : (tag[2] ?? "");
        if (rest.trim() !== "") current.push(rest);
      }
      continue;
    }
    current?.push(line);
  }
  finish();
  return examples;
}

/** The function its source makes, evaluated on its own. */
function relocate(text: string): unknown {
  return new Function(`"use strict"; return (${text});`)();
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;

async function runExample(example: Example, name: string, fn: unknown, scope: Readonly<Record<string, unknown>>, how: string): Promise<void> {
  const body = example.lines
    .map((line, index) => {
      const expected = /^(.*?)\s*\/\/\s*=>\s*(.+?)\s*$/.exec(line);
      if (expected) return `await $expect(${index}, async () => (${expected[1]}), () => (${expected[2]}));`;
      const throws = /^(.*?)\s*\/\/\s*throws\b\s*(.*?)\s*$/.exec(line);
      if (throws) return `await $throws(${index}, async () => { ${throws[1]}; }, ${JSON.stringify(throws[2])});`;
      return line;
    })
    .join("\n");
  const place = (index: number) => `${name}, ${how}, line ${index + 1} of the example: ${(example.lines[index] ?? "").trim()}`;
  const $expect = async (index: number, actual: () => Promise<unknown>, expected: () => unknown) => {
    let value: unknown;
    try {
      value = await actual();
    } catch (error) {
      throw new DoctestError(`${place(index)}\n  threw ${show(error)}`, { cause: error });
    }
    const wanted = expected();
    if (!equal(value, wanted)) throw new DoctestError(`${place(index)}\n  gave ${show(value)}, not ${show(wanted)}`);
  };
  const $throws = async (index: number, run: () => Promise<void>, spec: string) => {
    try {
      await run();
    } catch (error) {
      const [kind, ...message] = spec.split(":");
      const name = (error as { name?: unknown } | null)?.name;
      const text = (error as { message?: unknown } | null)?.message;
      if (kind?.trim() && kind.trim() !== name) throw new DoctestError(`${place(index)}\n  threw ${show(error)}, not a ${kind.trim()}`, { cause: error });
      if (message.length > 0 && message.join(":").trim() !== text) throw new DoctestError(`${place(index)}\n  threw ${show(error)}`, { cause: error });
      return;
    }
    throw new DoctestError(`${place(index)}\n  didn't throw`);
  };
  const names = Object.keys(scope).filter((key) => key !== name);
  let run: (...args: unknown[]) => Promise<void>;
  try {
    run = new AsyncFunction(name, ...names, "$expect", "$throws", `"use strict";\n${body}`);
  } catch (error) {
    throw new DoctestError(`${name}'s example isn't valid JavaScript: ${show(error)}`, { cause: error });
  }
  try {
    await run(fn, ...names.map((key) => scope[key]), $expect, $throws);
  } catch (error) {
    if (error instanceof DoctestError) throw error;
    throw new DoctestError(`${name}, ${how}: the example threw ${show(error)}`, { cause: error });
  }
}

/** Structural equality: primitives by `Object.is`, and arrays, plain objects, dates, maps, sets and errors by content. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index]));
  }
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  if (a instanceof Error || b instanceof Error) return a instanceof Error && b instanceof Error && a.name === b.name && a.message === b.message;
  if (a instanceof Map || b instanceof Map) {
    return a instanceof Map && b instanceof Map && a.size === b.size && [...a].every(([key, value]) => b.has(key) && equal(value, b.get(key)));
  }
  if (a instanceof Set || b instanceof Set) {
    return a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((item) => [...b].some((other) => equal(item, other)));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function show(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return String(value);
  try {
    return JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? `${item}n` : item)) ?? String(value);
  } catch {
    return String(value);
  }
}
