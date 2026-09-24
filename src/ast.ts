import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import type { FunctionNode } from "./marking.ts";

export type VisitorKeys = Readonly<Record<string, readonly string[] | undefined>>;

/** The nodes directly under `node`, in the order `visitorKeys` lists them. */
export function* childNodes(node: TSESTree.Node, visitorKeys: VisitorKeys): Generator<TSESTree.Node> {
  for (const key of visitorKeys[node.type] ?? []) {
    const child: unknown = (node as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (typeof item === "object" && item !== null && typeof (item as { type?: unknown }).type === "string") {
        yield item as TSESTree.Node;
      }
    }
  }
}

/** A replacement of the text in `range`. An empty range inserts. */
export interface Edit {
  readonly range: readonly [number, number];
  readonly text: string;
}

/** The text of `text` between `start` and `end`, with the edits inside that span applied. */
export function applyEdits(text: string, [start, end]: readonly [number, number], edits: readonly Edit[]): string {
  let result = "";
  let at = start;
  const inside = edits.filter((edit) => edit.range[0] >= start && edit.range[1] <= end);
  // Insertions sort before replacements that start at the same offset.
  for (const edit of inside.sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1])) {
    result += text.slice(at, edit.range[0]) + edit.text;
    at = edit.range[1];
  }
  return result + text.slice(at, end);
}

/**
 * The text range of a function's parameter list, inside its parentheses,
 * comments included. An arrow's lone unparenthesized parameter is its own range.
 */
export function parameterSpan(fn: FunctionNode, sourceCode: Readonly<TSESLint.SourceCode>): [number, number] {
  const closing =
    fn.type === AST_NODE_TYPES.ArrowFunctionExpression
      ? sourceCode.getTokenBefore(fn.returnType ?? arrowToken(fn, sourceCode))
      : sourceCode.getTokenBefore(fn.returnType ?? fn.body);
  if (closing?.value !== ")") {
    const [only] = fn.params;
    return only ? [only.range[0], only.range[1]] : [fn.range[0], fn.range[0]];
  }
  const opening = fn.params[0] ? sourceCode.getTokenBefore(fn.params[0]) : sourceCode.getTokenBefore(closing);
  return [opening?.range[1] ?? closing.range[0], closing.range[0]];
}

/** The `=>` of an arrow function. */
export function arrowToken(fn: TSESTree.ArrowFunctionExpression, sourceCode: Readonly<TSESLint.SourceCode>): TSESTree.Token {
  const token = sourceCode.getTokenBefore(fn.body, { filter: (candidate) => candidate.value === "=>" });
  if (!token) throw new Error("An arrow function without =>");
  return token;
}

/** Line terminators, as ECMAScript defines them. */
export const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/**
 * The comments inside `fn` that fall outside `spans`: the ones between the
 * parts of a signature that a rewrite copies, such as a note before `=>`.
 */
export function looseComments(
  fn: FunctionNode,
  spans: readonly (readonly [number, number])[],
  sourceCode: Readonly<TSESLint.SourceCode>,
): TSESTree.Comment[] {
  return sourceCode
    .getCommentsInside(fn)
    .filter((comment) => !spans.some(([start, end]) => comment.range[0] >= start && comment.range[1] <= end));
}

/** Comments as text to put before a body: a line comment ends its line, so the body starts on the next. */
export function renderComments(
  comments: readonly TSESTree.Comment[],
  sourceCode: Readonly<TSESLint.SourceCode>,
  indent: string,
): string {
  return comments
    .map((comment) => {
      const text = sourceCode.text.slice(comment.range[0], comment.range[1]);
      return comment.type === "Line" ? `${text}\n${indent}` : `${text} `;
    })
    .join("");
}
