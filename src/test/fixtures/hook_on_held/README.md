# hook_on_held fixtures: a copy of the library's

The six JSON files here are byte-for-byte copies of `tests/fixtures/hook_on_held/`
in the library repository, cohexa-ai/agent-coherence:

- branch: `feat/node-hook-client-held-refusal`
- commit: `ef12a8c0189a1806a73ddcc682fee83deac51d73`

The library is their only author. They are the contract the Node hook client is
held to when `.coherence/hook_on_held` asks it to refuse edits of held strict
files: the deny texts byte for byte, the decision table's rows, the setting's
value vectors and the stderr lines. The library byte-compares these copies with
its own, and `src/test/hook_on_held_fixtures.test.ts` checks each file against
the sha256 below.

Never edit these files by hand. To change one, change the library's file, then
copy all six again from the new library commit, for example
`git show <commit>:tests/fixtures/hook_on_held/holder_deny.json > holder_deny.json`,
and update the commit and the sums here.

```
cc856b664a5ca121bf45ee14eb70fda32edc44785f058a661a29da0e51f1c6f0  decision_table.json
702f632dd2a99043c5a80b60b78d5ddf8af57c1bb359c5c2dffb15154efd5fd0  holder_deny.json
933d9783aa0460357932db22b93607813ede216dbc5d43b233afd217f1cce547  parent_deny.json
2f8dc9fbc1e2e6ba38f9958009c1141a3c2f5fc1748ce1cbebab72d0cccd7432  setting_values.json
52514af51a0ac1dea8a7b02953eba816694d07f539120361904702a5918b7e3b  stderr_lines.json
d0fa72544aa5d60ff479aded538ab8275ff9012df7aac9af6d1fd6bb6e67011b  unavailable_deny.json
```
