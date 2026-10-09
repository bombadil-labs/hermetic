# Vocabulary

Each word here has one meaning, in the docs, in the rules' messages, in the public API and in the code the lift writes. When a new idea needs a word, it goes here first. Inside the source, ESLint's `context` and a parser's traversal state keep the names those tools give them.

## The property

- **Hermetic**: reads nothing but its inputs. Said of a function, a method or a class.
- **Input**: an argument, including `this`. `this` is an implicit first argument: `.call` passes it explicitly, and `.bind` fixes it in advance.
- **Hidden input**: anything else that code reads. Either a name from outside it, which is a *free variable* (an import, a module-level variable, or a global, built-ins included) or a *private name* of a class around it, or a construct that reaches outside without a name: `this` or `new.target` in an arrow function, `super`, `import.meta`, `import()`, JSX, or `with`. [Every check](packages/eslint-plugin-hermetic/docs/rules/no-hidden-inputs.md#every-check) lists the problem each one is reported as.
- **Portable**: its source is all of its behavior, so `new Function("return " + fn.toString())()` behaves exactly like `fn`, wherever it runs. Hermetic code is portable.
- **Needs**: the names hermetic code reads from `this`, which `check` lists.

## What code can be

- **Hermetic function**: reads only its arguments and `this`.
- **Hermetic method**: a hermetic function whose `this` is the object it's called on. It works on any object that has what it reads, so it can be tested with a plain object, or installed on another class.
- **Hermetic class**: a class that is hermetic as a whole. A class is its constructor, and the constructor's source is the whole class, so it is checked as one function: its heritage clause, fields, static blocks and methods. Its own `super`, private names and name are part of it.
- **Binding code**: code that isn't hermetic, and supplies the inputs of code that is. Every class is binding code for its methods: its constructor builds the object each method gets as `this`.
- **Branded** (reserved): a method that reads its inputs and the private names of its class, which are its brands. `#name in object` is what the language calls a brand check. Given the same arguments and instance, a branded method behaves the same, but it works only on instances of its class, so it isn't portable. Nothing checks for it yet.

## Binding

- **Bind**: give hermetic code its `this`, whether with `.bind`, `.call`, `inject` or `methods`, or by calling it as a method of an object.
- **Environment**: the object bound as `this`.
- **Root environment**: the one environment built from the realm. Every other environment is built from it, adding and replacing values, and each is frozen, so no function can change what another gets.
- **Realm**: a global object and its built-ins.
- **Intrinsics**: a realm's deterministic built-ins, which `intrinsics(realm)` picks out.

## Marking and checking

- **Mark**: say that code should be hermetic, with a `"use hermetic"` directive at the start of its body, or an `@hermetic` tag in the JSDoc block before it. A class is marked by its constructor's directive, or by the tag before the class.
- **Marked** and **hermetic** are separate facts. Marked code says it should be hermetic, and `hermetic/no-hidden-inputs` and `check` test whether it is.
- **`hermetic/no-hidden-inputs`**: the rule that reports the hidden inputs of marked code. It was called `hermetic/sealed` until 0.3.0.
- **`check`**: the same check at runtime, from source.
- **Form**: what `check` found the source to be: a function, a method or a class.
- **Candidate**: a function that `hermetic/prefer-hermetic` considers: an outermost function or method that has a name. Constructors aren't candidates, since marking one marks its class.

## The lift

- **Lift**: the `lift` fix of `hermetic/prefer-hermetic`. It splits a function or method whose hidden inputs are module-level names or globals into a core and a wrapper.
- **Core**: the hermetic function the lift writes, named after the original with `Hermetic` at the end, and a method's after its class or object too. It reads those hidden inputs from `this`. A method's core gets the method's object as its first argument, `self`, and its `arguments` object next, as `args`.
- **Wrapper**: the original function or method after a lift. It keeps its name, signature and export, and calls the core with the values it needs, and a method's object, so it is binding code.
- **Settled**: a module-level name that is initialized before a wrapper can run, and never reassigned. A wrapper passes settled values directly.
- **Context**: the environment a wrapper passes when some value isn't settled. It is one object, named after the core without `Hermetic` and with `Context` at the end, declared right after the wrapper's statement, whose getters read each value when the core does.
- **Unlift**: the lift's exact inverse. It folds each wrapper and its core back into the original function or method. `unliftPlugin` does it in builds.

## At run time

- **`inject`**: binds hermetic code to exactly its needs, taken from an environment.
- **`methods`**: installs hermetic functions on a class's prototype, so that each instance is bound as their `this` when they're called.
- **`confine`**: runs hermetic code in a Hardened JS compartment, whose global object is empty and whose shared built-ins are frozen.
- **`record`** and **`replay`**: `record` captures what a call does with its inputs, as a recording, and `replay` plays a recording back as a test.
- **`doctests`**: runs the examples in hermetic code's JSDoc, against the code and against a copy rebuilt from its source.

## What hermetic doesn't mean

- **Pure**: a hermetic function can change its inputs, or call methods on them that do I/O.
- **Deterministic**: a hermetic function behaves the same whenever its inputs are the same, but a clock or a random source can be one of them.
- **Sandboxed**: a hermetic function can still reach the program's shared built-ins through any value's prototype chain. `confine` is the sandbox.

## Words we don't use

- **sealed**, except as the rule's old name. JavaScript's `Object.seal` is something else (environments are frozen), and other languages' sealed classes are something else again.
- **binding**, for a declared name: say *name*, or *variable* when it's about what a name resolves to. For the lift's output, say *wrapper*. Binding means only giving code its `this`, as in *bind* and *binding code*.
- **binding layer**: say *binding code*.
- **context**, for any object bound as `this`: say *environment*. A context is only the lift's shared environment.
- **the hermetic function**, for what the lift writes: say *core*, since every marked function is meant to be hermetic.
- **bound to a name**, for a function that has one: say *has a name*, since bound refers to `this`.
- **ground**: the globals hermetic functions could read before 0.3.0. They read none now.
