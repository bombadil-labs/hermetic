import { AST_NODE_TYPES, AST_TOKEN_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { analyze, createEnvironment, type HermeticSettings, SETTINGS_SCHEMA } from "../analysis.ts";
import { isBinding, liftFix, planLift } from "../lift.ts";
import { directiveInsertion, type FunctionNode, functionName, isFunctionNode, isMarkedHermetic } from "../marking.ts";
import { createRule, sealed } from "./sealed.ts";

export interface PreferHermeticOptions extends HermeticSettings {
  /**
   * Also split functions whose only outside inputs are module bindings or
   * globals into a hermetic core and a binding that supplies them, keeping the
   * public name, signature and export. Off by default.
   */
  lift?: boolean;
}

type MessageIds = "alreadyHermetic" | "liftable";

export const preferHermetic = createRule<[PreferHermeticOptions], MessageIds>({
  name: "prefer-hermetic",
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description: "Mark functions hermetic when they already are, and optionally lift the rest",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...SETTINGS_SCHEMA,
          lift: { type: "boolean", description: "Split functions with only module-level or global inputs into a hermetic core and a binding." },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{}],
    messages: {
      alreadyHermetic: "'{{fn}}' is already hermetic. Mark it so it stays that way.",
      liftable: "'{{fn}}' reaches outside itself only for {{names}}. Lift them into its context to make it hermetic.",
    },
  },
  create(context, [options]) {
    const env = createEnvironment(context, options, sealed);
    const sourceCode = context.sourceCode;
    const typescript = /\.[cm]?tsx?$/.test(context.filename);
    return {
      ":function"(node: FunctionNode) {
        if (!isCandidate(node) || isMarkedHermetic(node, sourceCode)) return;
        const name = functionName(node);
        const problems = analyze(node, name, env);
        if (problems.length === 0) {
          context.report({
            node: nameNode(node),
            messageId: "alreadyHermetic",
            data: { fn: name },
            fix: (fixer) => markFix(fixer, node, sourceCode),
          });
          return;
        }
        if (!options.lift || isBinding(node, sourceCode)) return;
        const plan = planLift(node, problems, env);
        if (!plan) return;
        const names = [...plan.lifted.keys()];
        context.report({
          node: nameNode(node),
          messageId: "liftable",
          data: { fn: name, names: names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ") },
          fix: (fixer) => liftFix(fixer, plan, sourceCode, typescript),
        });
      },
    };
  },
});

/**
 * Outermost functions bound to a name: declarations, variable initializers,
 * and object or class members. Callbacks passed as arguments and IIFEs are
 * left alone; marking them would be noise.
 */
export function isCandidate(node: FunctionNode): boolean {
  for (let ancestor: TSESTree.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
    if (isFunctionNode(ancestor)) return false;
  }
  const parent = node.parent;
  switch (parent.type) {
    case AST_NODE_TYPES.Program:
    case AST_NODE_TYPES.ExportNamedDeclaration:
    case AST_NODE_TYPES.ExportDefaultDeclaration:
      return node.type === AST_NODE_TYPES.FunctionDeclaration || parent.type === AST_NODE_TYPES.ExportDefaultDeclaration;
    case AST_NODE_TYPES.VariableDeclarator:
      return parent.init === node;
    case AST_NODE_TYPES.Property:
    case AST_NODE_TYPES.MethodDefinition:
    case AST_NODE_TYPES.PropertyDefinition:
      return parent.value === node;
    default:
      return false;
  }
}

/** Where to point the report: the function's name rather than its whole body. */
export function nameNode(node: FunctionNode): TSESTree.Node {
  if (node.id) return node.id;
  const parent = node.parent;
  if (parent.type === AST_NODE_TYPES.VariableDeclarator) return parent.id;
  if (
    parent.type === AST_NODE_TYPES.Property ||
    parent.type === AST_NODE_TYPES.MethodDefinition ||
    parent.type === AST_NODE_TYPES.PropertyDefinition
  ) {
    return parent.key;
  }
  return node;
}

/** Adds `"use hermetic"` to a block body, or an `@hermetic` JSDoc tag for an expression-bodied arrow. */
function markFix(
  fixer: TSESLint.RuleFixer,
  node: FunctionNode,
  sourceCode: Readonly<TSESLint.SourceCode>,
): TSESLint.RuleFix {
  if (node.body.type === AST_NODE_TYPES.BlockStatement) {
    const { at, text } = directiveInsertion(node.body, sourceCode);
    return fixer.insertTextAfterRange([at, at], text);
  }
  const target = jsdocTarget(node);
  const jsdoc = sourceCode
    .getCommentsBefore(target)
    .findLast((comment) => comment.type === AST_TOKEN_TYPES.Block && comment.value.startsWith("*"));
  if (jsdoc) return addTag(fixer, jsdoc, sourceCode);
  const indent = lineIndent(sourceCode, target);
  const startsLine = sourceCode.lines[target.loc.start.line - 1]?.slice(0, target.loc.start.column).trim() === "";
  return fixer.insertTextBefore(target, startsLine ? `/** @hermetic */\n${indent}` : "/** @hermetic */ ");
}

/**
 * The node a JSDoc block sits before: the declaration or member that
 * introduces the function. A declaration with several declarators would mark
 * all of them, so there the tag goes directly before the arrow.
 */
function jsdocTarget(node: FunctionNode): TSESTree.Node {
  const parent = node.parent;
  switch (parent.type) {
    case AST_NODE_TYPES.VariableDeclarator: {
      const declaration = parent.parent;
      if (declaration.type !== AST_NODE_TYPES.VariableDeclaration || declaration.declarations.length > 1) return node;
      const outer = declaration.parent;
      return outer?.type === AST_NODE_TYPES.ExportNamedDeclaration ? outer : declaration;
    }
    case AST_NODE_TYPES.Property:
    case AST_NODE_TYPES.MethodDefinition:
    case AST_NODE_TYPES.PropertyDefinition:
      return parent;
    case AST_NODE_TYPES.ExportDefaultDeclaration:
      return parent;
    default:
      return node;
  }
}

/** Adds an `@hermetic` line to an existing JSDoc block, keeping its layout. */
function addTag(
  fixer: TSESLint.RuleFixer,
  comment: TSESTree.Comment,
  sourceCode: Readonly<TSESLint.SourceCode>,
): TSESLint.RuleFix {
  const indent = lineIndent(sourceCode, comment);
  const text = sourceCode.text.slice(comment.range[0], comment.range[1]);
  const lastBreak = text.lastIndexOf("\n");
  if (lastBreak !== -1 && text.slice(lastBreak + 1, -2).trim() === "") {
    // A closing line of its own: add the tag just above it.
    const star = text.slice(lastBreak + 1, -2);
    return fixer.insertTextAfterRange([comment.range[0], comment.range[0] + lastBreak], `\n${star}* @hermetic`);
  }
  const lines = comment.value
    .slice(1)
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
    .filter((line, i, all) => line !== "" || (i > 0 && i < all.length - 1));
  const body = [...lines, "@hermetic"].map((line) => `${indent} * ${line}`.trimEnd()).join("\n");
  return fixer.replaceText(comment, `/**\n${body}\n${indent} */`);
}

/** The whitespace that starts the line `node` begins on. */
function lineIndent(sourceCode: Readonly<TSESLint.SourceCode>, node: TSESTree.Node | TSESTree.Comment): string {
  const line = sourceCode.lines[node.loc.start.line - 1] ?? "";
  return /^\s*/.exec(line)?.[0] ?? "";
}
