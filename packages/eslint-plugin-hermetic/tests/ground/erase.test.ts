import { parseForESLint } from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import { eraseTypes, NonErasableSyntaxError } from "../../src/ground/erase.ts";

const erase = (code: string): string => {
  const { ast, visitorKeys } = parseForESLint(code, { range: true, loc: true, filePath: "snippet.ts" });
  return eraseTypes(code, ast, visitorKeys);
};

/** Runs a function body the way the loader would, after erasure. */
const run = (code: string): unknown => new Function(erase(code))();

describe("erasing TypeScript syntax", () => {
  it("runs the way TypeScript would compile it", () => {
    expect(run("function f(this: void, a: number, b?: number): number { return a + (b ?? 1); }\nreturn f(1);")).toBe(2);
    expect(run("const x = ({ a: 1 } as const).a satisfies number;\nreturn x;")).toBe(1);
    expect(run("let d!: number;\nd = 3;\nreturn d;")).toBe(3);
    expect(run("const id = <T,>(v: T): T => v;\nreturn id<number>(4);")).toBe(4);
    expect(run("interface I { a: number }\ntype T = string\nconst m = new Map<string, I>();\nm.set('k', { a: 5 });\nreturn m.get('k')!.a;")).toBe(5);
    expect(run("function o(a: string): string;\nfunction o(a: any): any { return a; }\nreturn o('6');")).toBe("6");
    expect(run("class C<T> { v: T; constructor(v: T) { this.v = v; } }\nreturn new C<number>(7).v;")).toBe(7);
    expect(run("const rest = (...xs: number[]): number => xs.length;\nreturn rest(1, 2, 3);")).toBe(3);
  });

  it("erases ambient declarations", () => {
    expect(run("declare const x: number;\ndeclare function f(): void;\ndeclare class C {}\ndeclare enum E { A }\ndeclare namespace N { const y: number; }\nreturn typeof x;")).toBe("undefined");
  });

  it("keeps every line and column in place", () => {
    const code = "function f<T>(this: void, a?: T): T[] {\n  let b!: number;\n  return [a as T] satisfies T[];\n}\n";
    const erased = erase(code);
    expect(erased).toHaveLength(code.length);
    for (let i = 0; i < code.length; i++) {
      if (code[i] === "\n") expect(erased[i]).toBe("\n");
      else if (erased[i] !== " " && erased[i] !== ";") expect(erased[i]).toBe(code[i]);
    }
  });

  it("stops automatic semicolon insertion from joining statements", () => {
    // Without the inserted `;`, each of these would run the next line as a call, index or tag.
    expect(run("let calls = 0; const g = () => { calls++; };\nconst a = g as unknown\n(0)\nreturn calls;")).toBe(0);
    expect(run("const arr = [1, 2];\nconst b = arr as number[]\n[0]\nreturn Array.isArray(b);")).toBe(true);
    expect(run("const tag = () => 'tagged';\nconst c = tag as unknown\n`x`\nreturn typeof c;")).toBe("function");
    expect(run("let calls = 0; const g = () => { calls++; };\nconst a = g as unknown // note\n(0)\nreturn calls;")).toBe(0);
  });

  it("refuses syntax that changes runtime behavior or needs rewriting", () => {
    for (const code of [
      "enum E { A }",
      "namespace N { export const a = 1; }",
      "const n = <number>(1 as unknown);",
      "class A { private x = 1; }",
      "class A { constructor(private x: number) {} }",
      "class A implements B {}",
      "abstract class A {}",
    ]) {
      expect(() => erase(code), code).toThrow(NonErasableSyntaxError);
    }
  });
});
