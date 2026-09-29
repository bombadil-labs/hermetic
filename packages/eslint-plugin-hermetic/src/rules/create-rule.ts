import { ESLintUtils } from "@typescript-eslint/utils";

/** Where each rule is documented, which ESLint links to from its reports. */
export function ruleDocs(name: string): string {
  return `https://github.com/bombadil-labs/hermetic/blob/main/packages/eslint-plugin-hermetic/docs/rules/${name}.md`;
}

export const createRule = ESLintUtils.RuleCreator(ruleDocs);
