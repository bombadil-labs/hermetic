import { AST_NODE_TYPES, AST_TOKEN_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { LINE_BREAK } from "./ast.ts";

export type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

export function isFunctionNode(node: TSESTree.Node | null | undefined): node is FunctionNode {
  return (
    node?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node?.type === AST_NODE_TYPES.FunctionDeclaration ||
    node?.type === AST_NODE_TYPES.FunctionExpression
  );
}

/** True when the function carries a `"use hermetic"` directive or an `@hermetic` JSDoc tag. */
export function isMarkedHermetic(node: FunctionNode, sourceCode: Readonly<TSESLint.SourceCode>): boolean {
  return hasHermeticDirective(node) || hasHermeticTag(node, sourceCode);
}

/** True when `"use hermetic"` appears in the function body's directive prologue. */
export function hasHermeticDirective(node: FunctionNode): boolean {
  if (node.body.type !== AST_NODE_TYPES.BlockStatement) return false;
  for (const statement of node.body.body) {
    if (statement.type !== AST_NODE_TYPES.ExpressionStatement || statement.directive === undefined) return false;
    if (statement.directive === "use hermetic") return true;
  }
  return false;
}

/**
 * Where a `"use hermetic"` directive goes in a block body: straight after the
 * opening brace. Every comment keeps its line and the statement it precedes,
 * so a `// @ts-expect-error` or `// eslint-disable-next-line` above the first
 * statement still reaches it, and a comment trailing the brace stays on the
 * brace's line.
 */
export function directiveInsertion(
  body: TSESTree.BlockStatement,
  sourceCode: Readonly<TSESLint.SourceCode>,
): { at: number; text: string } {
  const brace = body.range[0] + 1;
  const next = sourceCode.getTokenAfter(sourceCode.getFirstToken(body) ?? body, { includeComments: true });
  if (!next || next.loc.start.line === body.loc.start.line) {
    return { at: brace, text: next?.range[0] === brace ? ' "use hermetic"; ' : ' "use hermetic";' };
  }
  // Only whitespace separates the brace from the next line: start a line of its own, in the body's line-break style.
  const lineBreak = LINE_BREAK.exec(sourceCode.text.slice(brace, next.range[0]));
  const at = brace + (lineBreak?.index ?? 0);
  const indent = lineIndent(sourceCode, next.loc.start.line);
  const closing = next.range[0] === body.range[1] - 1;
  return {
    at,
    text: `${lineBreak?.[0] ?? "\n"}${closing ? `${indent}${indent.includes("\t") ? "\t" : "  "}` : indent}"use hermetic";`,
  };
}

function lineIndent(sourceCode: Readonly<TSESLint.SourceCode>, line: number): string {
  return /^\s*/.exec(sourceCode.lines[line - 1] ?? "")?.[0] ?? "";
}

/**
 * True when a JSDoc block directly before the function, or before the
 * declaration that introduces it, has an `@hermetic` tag.
 */
export function hasHermeticTag(node: FunctionNode, sourceCode: Readonly<TSESLint.SourceCode>): boolean {
  return annotationTargets(node).some((target) =>
    sourceCode
      .getCommentsBefore(target)
      .some((comment) => comment.type === AST_TOKEN_TYPES.Block && isHermeticJSDoc(comment.value)),
  );
}

/**
 * True for the body of a `/** ... *\/` comment with an `@hermetic` block tag.
 * Like TypeScript, only a tag at the start of a line counts, so prose that
 * mentions the tag mid-sentence does not mark anything.
 */
export function isHermeticJSDoc(commentValue: string): boolean {
  "use hermetic";
  return commentValue.startsWith("*") && /^[\s*]*@hermetic(?=\s|$)/m.test(commentValue);
}

/** The nodes a JSDoc block may sit in front of to annotate `node`. */
function annotationTargets(node: FunctionNode): TSESTree.Node[] {
  const targets: TSESTree.Node[] = [node];
  let declaration: TSESTree.Node = node;
  const parent = node.parent;
  switch (parent.type) {
    case AST_NODE_TYPES.VariableDeclarator:
      if (parent.init !== node) return targets;
      declaration = parent.parent;
      targets.push(declaration);
      break;
    case AST_NODE_TYPES.Property:
    case AST_NODE_TYPES.MethodDefinition:
    case AST_NODE_TYPES.PropertyDefinition:
    case AST_NODE_TYPES.AccessorProperty:
      if (parent.value === node) targets.push(parent);
      return targets;
    case AST_NODE_TYPES.AssignmentExpression:
      if (parent.right === node && parent.parent.type === AST_NODE_TYPES.ExpressionStatement) {
        targets.push(parent.parent);
      }
      return targets;
    default:
      break;
  }
  const outer = declaration.parent;
  if (
    outer?.type === AST_NODE_TYPES.ExportNamedDeclaration ||
    outer?.type === AST_NODE_TYPES.ExportDefaultDeclaration
  ) {
    targets.push(outer);
  }
  return targets;
}

/** A readable name for diagnostics. */
export function functionName(node: FunctionNode): string {
  if (node.id) return node.id.name;
  const parent = node.parent;
  switch (parent.type) {
    case AST_NODE_TYPES.VariableDeclarator:
      if (parent.init === node && parent.id.type === AST_NODE_TYPES.Identifier) return parent.id.name;
      break;
    case AST_NODE_TYPES.Property:
    case AST_NODE_TYPES.MethodDefinition:
    case AST_NODE_TYPES.PropertyDefinition:
    case AST_NODE_TYPES.AccessorProperty: {
      const key = parent.value === node ? keyName(parent.key, parent.computed) : undefined;
      if (key !== undefined) return key;
      break;
    }
    case AST_NODE_TYPES.AssignmentExpression:
      if (parent.right !== node) break;
      if (parent.left.type === AST_NODE_TYPES.Identifier) return parent.left.name;
      if (parent.left.type === AST_NODE_TYPES.MemberExpression) {
        const key = keyName(parent.left.property, parent.left.computed);
        if (key !== undefined) return key;
      }
      break;
    case AST_NODE_TYPES.ExportDefaultDeclaration:
      return "default";
    default:
      break;
  }
  return "<anonymous>";
}

function keyName(key: TSESTree.Node, computed: boolean): string | undefined {
  if (!computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
  if (key.type === AST_NODE_TYPES.PrivateIdentifier) return `#${key.name}`;
  return staticKey(key);
}

/** The property name of a literal key, such as `"random"` in `Math["random"]`. */
export function staticKey(node: TSESTree.Node): string | undefined {
  if (node.type === AST_NODE_TYPES.Literal) {
    const { value } = node;
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
    return undefined;
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}
