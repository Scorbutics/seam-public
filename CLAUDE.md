Reuse the existing components before trying to create new ones.

Isolate every language specific code into their dedicated folder.
Keep the language specific and framework specific code very small.

We need to support at minimum those languages:
 - Typescript
 - Java
 - Ruby
 - C
 - C++
when doing a change.

Always favor refactoring of similar existing code / components / algorithm before starting to write new code. It of course only applies if something is already existing.

Semantic vs structural — never confuse them:
 - A SEMANTIC judgement (understanding natural language: an intent, a goal, a direction, "what does the user mean") belongs to the LLM or embeddings. NEVER keyword-match / regex / string-parse free text in the engine to approximate meaning — it dies on typos, other languages, and indirect wording. If a real signal isn't available, accept it as non-deterministic (delegate to the model) rather than faking determinism with a brittle proxy.
 - A STRUCTURAL classification (a known, closed set: node kinds, edge kinds, roles, languages) is deterministic — but source it from the registry / source-of-truth, never a hardcoded list that has to be kept in sync.

In plan and agent modes, do not hesitate to ask questions if you need more information, in particular for huge complex tasks.

For the architecture / high complexity code related tasks, behave like a Senior Software engineer / an architect.

Challenge the solutions I am proposing (if there is an existing better way, don't challenge everything for the sake of challenge...).
