import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { analyze, createAnalysis, type HermeticSettings, type MessageIds, SETTINGS_SCHEMA } from "../analysis.ts";
import { type ClassNode, className, constructedClass, type FunctionNode, functionName, hasHermeticTag, isMarkedHermetic } from "../marking.ts";
import { createRule, ruleDocs } from "./create-rule.ts";

export type { MessageIds } from "../analysis.ts";

/**
 * Options for `hermetic/no-hidden-inputs`. Each may also be set once for
 * every rule in `settings.hermetic`; the rule's own options win.
 *
 * - `types`: `"allow"` (default) permits type-only references that escape the
 *   function, since types are erased. `"structural-only"` reports escaping
 *   references to declared types, so the function can move to another file
 *   unchanged. Lib and other global types stay allowed.
 */
export type NoHiddenInputsOptions = HermeticSettings;

/** @deprecated Renamed to {@link NoHiddenInputsOptions} in 0.3.0. */
export type SealedOptions = NoHiddenInputsOptions;

type NoHiddenInputs = TSESLint.RuleModule<MessageIds, [NoHiddenInputsOptions]> & { name: string };

const description = "Disallow hidden inputs in code marked hermetic";

export const noHiddenInputs: NoHiddenInputs = createRule<[NoHiddenInputsOptions], MessageIds>({
  name: "no-hidden-inputs",
  meta: {
    type: "problem",
    docs: { description },
    schema: [{ type: "object", properties: SETTINGS_SCHEMA, additionalProperties: false }],
    defaultOptions: [{}],
    messages: {
      freeVariable:
        "'{{name}}' is a free variable in hermetic function '{{fn}}'. Pass it through 'this' or an argument.",
      privateName:
        "'{{name}}' in hermetic function '{{fn}}' is a private name of the class around it, so the function works only inside that class. Read it through a public property of 'this', or an argument.",
      typeReference:
        "Type reference '{{name}}' in hermetic function '{{fn}}' refers to a declaration outside it. With types: \"structural-only\", write the type inline.",
      lexicalThis:
        "'this' in hermetic function '{{fn}}' comes from the enclosing scope, not from its inputs. Only a function that isn't an arrow receives its own 'this'.",
      lexicalNewTarget:
        "'new.target' in hermetic function '{{fn}}' comes from the enclosing scope. Only a function that isn't an arrow has its own 'new.target'.",
      superReference:
        "'super' in hermetic function '{{fn}}' refers to the enclosing class or object. Pass the behavior through 'this' or an argument.",
      importMeta:
        "'import.meta' in hermetic function '{{fn}}' refers to the enclosing module. Pass the value through 'this' or an argument.",
      dynamicImport:
        "Dynamic import() in hermetic function '{{fn}}' loads a module that is not one of its inputs. Pass the module through 'this' or an argument.",
      jsx: "JSX in hermetic function '{{fn}}' compiles to a call to the JSX factory, which is a free variable. Pass an element factory through 'this' or an argument.",
    },
  },
  create(context, [options]) {
    const analysis = createAnalysis(context, options);
    const marked = new Map<TSESTree.Node, string>();
    /** Nested hermetic functions share escapes; each node is reported once, for the innermost. */
    const reported = new Set<TSESTree.Node>();
    const check = (node: FunctionNode | ClassNode, name: string): void => {
      for (const { node: target, messageId, data } of analyze(node, name, analysis)) {
        if (reported.has(target)) continue;
        reported.add(target);
        context.report({ node: target, messageId, data });
      }
    };

    return {
      // A JSDoc tag before a class marks it, as the directive in its constructor does.
      "ClassDeclaration, ClassExpression"(node: ClassNode) {
        if (hasHermeticTag(node, context.sourceCode)) marked.set(node, className(node));
      },
      ":function"(node: FunctionNode) {
        if (!isMarkedHermetic(node, context.sourceCode)) return;
        // A class is its constructor: marking the constructor marks the whole class, whose source it is.
        const owner = constructedClass(node);
        if (owner) marked.set(owner, className(owner));
        else marked.set(node, functionName(node));
      },
      // Inner functions exit first, so shared escapes are attributed to the innermost hermetic function.
      ":function:exit"(node: FunctionNode) {
        const name = marked.get(node);
        if (name !== undefined) check(node, name);
      },
      // A class exits after its members, so a marked method inside it reports its own escapes first.
      "ClassDeclaration, ClassExpression:exit"(node: ClassNode) {
        const name = marked.get(node);
        if (name !== undefined) check(node, name);
      },
    };
  },
});

/**
 * The rule's name until 0.3.0, kept so that existing configs and
 * `eslint-disable` comments keep working. It reports what
 * `hermetic/no-hidden-inputs` reports.
 *
 * @deprecated Use {@link noHiddenInputs}, `hermetic/no-hidden-inputs`.
 */
export const sealed: NoHiddenInputs = {
  ...noHiddenInputs,
  name: "sealed",
  meta: {
    ...noHiddenInputs.meta,
    docs: { description, url: ruleDocs("sealed") },
    deprecated: {
      message: "hermetic/sealed was renamed to hermetic/no-hidden-inputs, which reports the same problems.",
      url: ruleDocs("sealed"),
      replacedBy: [{ rule: { name: "no-hidden-inputs", url: ruleDocs("no-hidden-inputs") } }],
      deprecatedSince: "0.3.0",
      availableUntil: "1.0.0",
    },
  },
};
