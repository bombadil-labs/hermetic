// Every kind of erasable TypeScript syntax the loader supports.
interface Allow {
  readonly [name: string]: unknown;
}
type Deny = readonly string[];

export function ground<R extends typeof globalThis>(this: void, realm: R, extra?: Deny): { allow: Allow; deny: Deny } {
  "use hermetic";
  type Local = { readonly math: R["Math"] };
  let deny!: string[];
  deny = [...(extra ?? []), "Math.random"] satisfies Deny as string[];
  const pick = <K extends keyof R>(key: K): R[K] => realm[key]!;
  const local: Local = { math: pick("Math") as R["Math"] };
  function twice(n: number): number;
  function twice(n: any): any {
    return n * 2;
  }
  return { allow: { Math: local.math, JSON: pick("JSON"), twice: twice(1) }, deny };
}
