import { RuleTester } from "@typescript-eslint/rule-tester";
import { RuleTester as ESLintRuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

// Both rule testers default to mocha-style globals; point them at vitest.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

ESLintRuleTester.describe = describe;
ESLintRuleTester.it = it;
ESLintRuleTester.itOnly = it.only;
