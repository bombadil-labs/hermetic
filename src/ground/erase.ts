import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { childNodes, type VisitorKeys } from "../ast.ts";
import { isFunctionNode } from "../marking.ts";

/** TypeScript syntax that changes runtime behavior, or cannot be erased without rewriting code. */
export class NonErasableSyntaxError extends Error {
  override name = "NonErasableSyntaxError";
  readonly node: TSESTree.Node;

  constructor(node: TSESTree.Node, what: string) {
    super(`${what} cannot be erased to plain JavaScript`);
    this.node = node;
  }
}

/**
 * Returns the source text of `node` with TypeScript-only syntax replaced by
 * spaces. Newlines are kept and nothing moves, so every line and column in the
 * result matches the original file, the approach of Node's type stripping.
 * A `;` is left behind where erasing would otherwise let automatic semicolon
 * insertion join two statements.
 *
 * Only erasable syntax is supported: annotations, `as`, `satisfies`, `!`,
 * generics, `this` parameters, optional markers, and local type declarations.
 * Anything else throws `NonErasableSyntaxError`.
 */
export function eraseTypes(text: string, node: TSESTree.Node, visitorKeys: VisitorKeys): string {
  const [start, end] = node.range;
  const erased = new Uint8Array(end - start);
  const semicolons = new Set<number>();

  const erase = (from: number, to: number): void => {
    erased.fill(1, from - start, to - start);
  };
  const eraseStatement = (target: TSESTree.Node): void => {
    erase(target.range[0], target.range[1]);
    semicolons.add(target.range[0]);
  };
  /** Erases the first `char` between `from` and `to`, such as the `?` in `a?: T`. */
  const eraseMarker = (char: string, from: number, to: number): void => {
    const at = text.indexOf(char, from);
    if (at !== -1 && at < to) erase(at, at + 1);
  };

  const visit = (current: TSESTree.Node): void => {
    switch (current.type) {
      case AST_NODE_TYPES.TSTypeAnnotation:
      case AST_NODE_TYPES.TSTypeParameterDeclaration:
      case AST_NODE_TYPES.TSTypeParameterInstantiation:
        erase(current.range[0], current.range[1]);
        return;
      case AST_NODE_TYPES.TSInterfaceDeclaration:
      case AST_NODE_TYPES.TSTypeAliasDeclaration:
      case AST_NODE_TYPES.TSDeclareFunction:
        eraseStatement(current);
        return;
      case AST_NODE_TYPES.TSAsExpression:
      case AST_NODE_TYPES.TSSatisfiesExpression: {
        const suffix = current.expression.range[1];
        erase(suffix, current.range[1]);
        // `x as T` ends a statement where `x` alone would run into a following `(`, `[` or template.
        if (continuesOnNextLine(text, current.range[1])) semicolons.add(suffix);
        visit(current.expression);
        return;
      }
      case AST_NODE_TYPES.TSNonNullExpression:
        erase(current.range[1] - 1, current.range[1]);
        visit(current.expression);
        return;
      case AST_NODE_TYPES.VariableDeclaration:
        // `declare const x: T` only describes something that exists elsewhere.
        if (current.declare) {
          eraseStatement(current);
          return;
        }
        break;
      case AST_NODE_TYPES.VariableDeclarator:
        if (current.definite && current.id.type === AST_NODE_TYPES.Identifier) {
          eraseMarker("!", current.id.range[0] + current.id.name.length, current.id.range[1]);
        }
        break;
      case AST_NODE_TYPES.TSTypeAssertion:
        throw new NonErasableSyntaxError(current, "An angle-bracket type assertion (use `as` instead)");
      case AST_NODE_TYPES.TSEnumDeclaration:
        if (current.declare) {
          eraseStatement(current);
          return;
        }
        throw new NonErasableSyntaxError(current, "An enum");
      case AST_NODE_TYPES.TSModuleDeclaration:
        if (current.declare) {
          eraseStatement(current);
          return;
        }
        throw new NonErasableSyntaxError(current, "A namespace");
      case AST_NODE_TYPES.TSParameterProperty:
        throw new NonErasableSyntaxError(current, "A parameter property");
      case AST_NODE_TYPES.TSImportEqualsDeclaration:
      case AST_NODE_TYPES.TSExportAssignment:
        throw new NonErasableSyntaxError(current, "An import or export assignment");
      case AST_NODE_TYPES.ClassDeclaration:
      case AST_NODE_TYPES.ClassExpression:
        if (current.declare) {
          eraseStatement(current);
          return;
        }
        if (current.abstract || current.implements.length > 0) {
          throw new NonErasableSyntaxError(current, "TypeScript class syntax");
        }
        break;
      case AST_NODE_TYPES.MethodDefinition:
      case AST_NODE_TYPES.PropertyDefinition:
      case AST_NODE_TYPES.AccessorProperty:
        if (
          current.accessibility ||
          current.override ||
          current.optional ||
          ("declare" in current && current.declare) ||
          ("readonly" in current && current.readonly) ||
          ("definite" in current && current.definite) ||
          current.value?.type === AST_NODE_TYPES.TSEmptyBodyFunctionExpression
        ) {
          throw new NonErasableSyntaxError(current, "TypeScript class member syntax");
        }
        break;
      case AST_NODE_TYPES.TSAbstractMethodDefinition:
      case AST_NODE_TYPES.TSAbstractPropertyDefinition:
      case AST_NODE_TYPES.TSAbstractAccessorProperty:
      case AST_NODE_TYPES.TSIndexSignature:
        throw new NonErasableSyntaxError(current, "TypeScript class member syntax");
      default:
        break;
    }

    if (isFunctionNode(current)) {
      const [first, second] = current.params;
      if (first?.type === AST_NODE_TYPES.Identifier && first.name === "this") {
        erase(first.range[0], second ? second.range[0] : first.range[1]);
      }
      for (const param of current.params) {
        if (param.type === AST_NODE_TYPES.Identifier && param.optional) {
          eraseMarker("?", param.range[0] + param.name.length, param.typeAnnotation?.range[0] ?? param.range[1]);
        }
      }
    }

    for (const child of childNodes(current, visitorKeys)) visit(child);
  };

  visit(node);

  let result = "";
  for (let i = start; i < end; i++) {
    const char = text[i] ?? "";
    if (!erased[i - start]) result += char;
    else if (semicolons.has(i)) result += ";";
    else result += LINE_BREAK.test(char) ? char : " ";
  }
  return result;
}

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * True when the next token after `from` starts a new line with `(`, `[` or a
 * template: tokens that, without a semicolon, JavaScript would attach to the
 * previous line.
 */
function continuesOnNextLine(text: string, from: number): boolean {
  let lineBreak = false;
  for (let i = from; i < text.length; ) {
    const char = text[i] ?? "";
    if (text.startsWith("//", i)) {
      const next = text.slice(i).search(LINE_BREAK);
      i = next === -1 ? text.length : i + next;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return false;
      lineBreak ||= LINE_BREAK.test(text.slice(i, close));
      i = close + 2;
    } else if (/\s/.test(char)) {
      lineBreak ||= LINE_BREAK.test(char);
      i++;
    } else {
      return lineBreak && (char === "(" || char === "[" || char === "`");
    }
  }
  return false;
}

