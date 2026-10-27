# Source-bound Writer method edits

This increment handles formal Reviewer findings that do not request a missing scenario and whose cited lines identify existing unittest methods. The Writer returns only those methods, inside their existing class-name wrappers in one Python fence. Complete suite replies, module imports, fixtures, unrelated methods and method renames are rejected. A necessary import can be local to a selected method.

`WRITER_METHOD_EDIT_V1` supplies the original candidate `baselineHash`, a `planHash` and exact `methodIds`. The complete read-only candidate, source context and original structured review findings remain in the prompt. No source, finding or basis is clipped to make this request fit. Existing final request capacity checks decide whether it can be sent.

## Composition contract

`edit_test_methods.py` parses text without importing or executing submitted code. Its plan binds the exact UTF-8 baseline and cited lines to direct `test_` methods in known unittest TestCase classes. It supports multiple classes, same method names in different classes, async methods, existing decorators and CRLF. Ambiguous definitions, class/fixture/module lines and unsupported layouts return explicit reasons and grant no whole-file editing permission.

The response must supply every planned method exactly once. Signatures, annotations, decorators and async status must remain AST-equivalent. Class wrappers only identify the existing owner; they cannot change its base, decorators or fixtures. Multiple owners require explicit class wrappers. Replacements may be formatted within their selected spans; literal values remain AST values. Every byte outside those original spans, including other methods and fixtures, stays unchanged.

Apply reconstructs the plan from the original baseline and checks both hashes. It rejects no-op edits, missing/duplicate methods, scope expansion and signature changes. Python compares the resulting AST with the original after excluding only the selected method bodies. Node separately checks the returned offsets against its original plan, rebuilds the UTF-8 byte edits and verifies the complete output hash and bytes. Neither operation creates inputs, expected values or assertions.

Both baseline and replacement have a 1 MiB UTF-8 limit, parsed trees have a 20,000-node limit and a plan can select at most 32 methods. Tool transport, invalid DTOs and timeouts stop as tool failures. A malformed model replacement remains a rejected model edit; it does not authorize native execution or silently become a partial success.

## Formal workflow

The host caches the exact original plan and complete review packet for bounded correction. A rejected edit uses the existing revision budget and deadline. It cannot extend the deadline, add requests or fall back to rewriting the entire baseline. A changed or unavailable tool result does not trigger model repair of the tool.

The composed candidate still passes existing preservation, structure, source-bound observations, native target execution, fresh same-candidate Reviewer approval and coverage/mutation gates. When editing an unapproved quality addition, the original approved seed stays protected and the existing exact focus-input and parameter-fixture replay checks run again on the entire composition. An `applied` event records AST composition; it is not execution, review or quality approval.

The fixed Writer qualification probe still certifies only its public sample. It does not establish a model's method-edit capability; formal edits must pass the actual contract and gates.

## Remaining scope

Pure `missing-scenario` reviews now use addition-only composition against the exact executed candidate under review, including any quality additions it already contains. The host caches that complete review packet by candidate hash across rejected fragments. The response contract contains no full-file rewrite instruction; at least one new method is required. Existing methods and fixtures remain with the host. Ambiguous bare methods across multiple TestCase classes require an explicit existing class header, rather than an inferred owner. Merge tool failure stops; model scope rejection uses only the remaining original revision budget. The complete composition still needs native execution and fresh same-candidate approval.

Mixed review findings and general structure/fixture revisions still use the existing paths. Routing every operation through explicit local addition/replacement scopes remains part of generalization priority 2. Independent requirement-file/oracle input, measured capability adaptation and held-out real-model acceptance remain separate priorities. Local regression fixtures do not establish arbitrary-project or cross-platform support.
