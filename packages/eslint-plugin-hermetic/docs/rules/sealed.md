# hermetic/sealed

Renamed to [`hermetic/no-hidden-inputs`](no-hidden-inputs.md) in 0.3.0, which reports the same problems. The old name still works in 0.3, and is deprecated: ESLint lists it among the deprecated rules a config uses. It will be removed in 1.0.

To move, change the rule's name in your config and in any `eslint-disable` comments:

```diff
- "hermetic/sealed": "error",
+ "hermetic/no-hidden-inputs": "error",
```
