/**
 * The ground: the global names an isolated function may assume, plus member
 * paths inside those globals that stay off limits.
 */
export interface Ground {
  /** Global names an isolated function may read. */
  readonly names: ReadonlySet<string>;
  /** Denied member paths as segment lists, such as `["Math", "random"]`. Each has at least two segments. */
  readonly deny: readonly (readonly string[])[];
}

/**
 * What a ground bootstrap returns. The linter reads only the keys of `allow`;
 * the values are for runtime use, such as building Compartment globals.
 */
export interface GroundConfig {
  readonly allow: Readonly<Record<string, unknown>>;
  readonly deny?: readonly string[];
}

/**
 * Builds a ground from allowed names and dotted deny paths. A one-segment deny
 * path removes the name from the ground entirely.
 */
export function createGround(allow: Iterable<string>, deny: Iterable<string> = []): Ground {
  "use isolated";
  const names = new Set(allow);
  const paths: string[][] = [];
  for (const path of deny) {
    const segments = path.split(".");
    if (segments.some((segment) => segment.trim() !== segment || segment === "")) {
      throw new TypeError(`Invalid deny path '${path}'. Use dotted member names, such as 'Math.random'.`);
    }
    if (segments.length === 1) names.delete(path);
    else paths.push(segments);
  }
  return { names, deny: paths };
}

/** True when `path` is exactly one of the ground's denied paths. */
export function isDenied(ground: Ground, path: readonly string[]): boolean {
  "use isolated";
  return ground.deny.some(
    (denied) => denied.length === path.length && denied.every((segment, i) => segment === path[i]),
  );
}

/** True when some denied path lies strictly beneath `path`, such as `Math` for `Math.random`. */
export function hasDeniedMembers(ground: Ground, path: readonly string[]): boolean {
  "use isolated";
  return ground.deny.some(
    (denied) => denied.length > path.length && path.every((segment, i) => segment === denied[i]),
  );
}

/**
 * The default ground, used when no bootstrap is configured: intrinsics that
 * are deterministic and do not depend on the host.
 *
 * Left out on purpose: `Date` (reads the clock); `fetch`, `crypto`, `console`,
 * timers, `process`, `globalThis`, `window` and `document` (ambient
 * authority); `eval` and `Function` (code loading); `Intl` (host locale).
 */
export const DEFAULT_GROUND_ALLOW: readonly string[] = [
  // Value globals
  "undefined",
  "NaN",
  "Infinity",
  // Data structures
  "Array",
  "Object",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  // Primitives
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  // Structured data
  "JSON",
  "RegExp",
  "Promise",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  // Math, minus Math.random below
  "Math",
];

/** `Math.random` is nondeterministic. */
export const DEFAULT_GROUND_DENY: readonly string[] = ["Math.random"];

export const DEFAULT_GROUND: Ground = createGround(DEFAULT_GROUND_ALLOW, DEFAULT_GROUND_DENY);
