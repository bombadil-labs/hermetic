/**
 * The expression that rebuilds a function, method or class from its source
 * alone. A method's source, such as `area() { … }`, is no expression on its
 * own, so it becomes the only member of an object literal, from which
 * `onlyMember` takes it back out.
 */
export function rebuildable(source: string, form: "function" | "method" | "class" | undefined): string {
  return form === "method" ? `({${source}\n})` : `(${source}\n)`;
}

/** The one method of an object literal that `rebuildable` made: its value, getter or setter. */
export function onlyMember(holder: unknown): unknown {
  if ((typeof holder !== "object" && typeof holder !== "function") || holder === null) return undefined;
  const keys = Reflect.ownKeys(holder);
  const descriptor = keys.length === 1 && keys[0] !== undefined ? Reflect.getOwnPropertyDescriptor(holder, keys[0]) : undefined;
  return descriptor?.value ?? descriptor?.get ?? descriptor?.set;
}
