# Reviewer evidence basis contract

The formal protocol is `review-v8`. Every finding has exactly `category`, `test_line`, `reason`, `action`, and `basis`. A basis makes the premise and its origin inspectable; it does not prove arbitrary prose, business correctness, execution, or mutation quality.

```json
{
  "findings": [{
    "category": "missing-scenario",
    "test_line": "L5",
    "reason": "This case checks input 1; no separate negative-input case is present.",
    "action": "Add a separate negative-input case after obtaining its controlled observation or explicit requirement.",
    "basis": {"kind": "test-code", "ref": "L5", "field": "judgment", "value": "unverified"}
  }]
}
```

All four basis fields are strings. Unknown keys, missing fields, non-string values and oversized fields are rejected. Findings retain the existing maximum of five, line references and actionable reason/action rules. `{"findings":[]}` remains the no-demonstrated-defect response; the host never removes invalid findings to manufacture it.

| Kind | Reference and claim | Host check |
| --- | --- | --- |
| `host-fact` | Supplied fact ID, explicit scalar field and exact scalar spelling | Same candidate/source/run, related test location, field presence and equality. Boolean spellings are `true` and `false`. |
| `evidence-gap` | Assertion ID; `observationStatus` or `expectedOrigin` with value `unknown` | The host must explicitly report unknown. Absence does not become an unknown fact, a conflict, or a wrong expected value. |
| `test-code` | Same `test_line`; `field=judgment`, `value=unverified` | Identifies semantic advice as unverified. Existing constraint, preservation, execution and quality checks still apply. |
| `requirement` | Supplied `R` ID; `field=statement`, exact supplied statement as value | Requirement packet must match source/run/target and contain one matching ID and statement. A claimed specification without a supplied reference is rejected. |

## Fact identity and scope

`HOST_VERIFIED_REVIEW_FACTS_V1` retains its existing typed facts and adds prompt-only IDs: `E1` for execution metadata, `I1` for an import, `H1` for a harness class, `M1` for a test method, and `A1.1`/`C1.1` for an assertion/call in that method. IDs are local to this exact candidate and evidence packet. They are not independent execution or approval identities and must not be reused across candidate hashes.

Only present fields in this allowlist are addressable: `E` executionVerified; `I` binding/origin; `H` name/kind; `M` name; `A` kind/targetResult/expectedOrigin/expectedType/observationStatus; `C` observationReturned. Assertion snapshots, raw call inputs, source text, line/range metadata and arbitrary object paths cannot be evaluated through `field`. Assertion references must cite their line; calls may also support their bound assertion. Import references may support their known uses; method references stay within that method. Another test's assertion cannot justify a finding here.

For example, `{"kind":"host-fact","ref":"A1.1","field":"expectedOrigin","value":"static-literal"}` is a valid premise only when that cited assertion has the supplied fixed-literal fact. Claiming `runtime-computed` against it is rejected regardless of the language used in reason/action. Matching this premise does not independently prove the accompanying semantic judgment. Existing bounded prose contradiction checks remain additional defenses.

## Requirements and migration

The host API accepts an optional `ReviewRequirements` packet containing only `runId`, `sourceHash`, `target`, and up to 64 unique `{id, statement}` items. IDs have the form `R` plus 16 lowercase hexadecimal characters; statements are nonempty and at most 600 characters. Prompt composition and parsing must receive the same bound packet. Unknown packet/item fields, duplicate IDs and identity drift are rejected before approval.

This is a host interface, not yet a user-facing requirement-file loader or an independent oracle generator. The third generalization priority supplies that entry point. Source formulas and implementation observations do not automatically become independent requirements.

A registered independent requirement remains reviewable when the observed implementation returns a different value or exception. This uses the bound requirement identity, not language-specific words in the reason. It does not change the test or implementation automatically; a mismatch still needs resolution and fresh validation.

Current observed-outcome checks grant their independent-requirement exemption only to a registered requirement basis. Merely mentioning a business specification in unverified model prose does not grant that exemption. The historical reader retains its previous prose heuristics.

Formal parsing and role probes require v8 findings. The historical reader still accepts v7 findings without basis when explicitly used as a compatibility reader; this cannot certify a current role. Qualification identity is `python-unittest-v9`, so earlier cached qualifications cannot be inherited. Optional prior qualification remains optional; actual candidates still require real execution and same-candidate review.

Schema-capable transports receive the same nested basis schema. Text fallback retains the same local parser and acceptance rules. A rejected assessment receives at most the existing single correction under the original deadline. Persistent contradictions block review and mutation; report projections show bounded, escaped, redacted bases without storing complete provider replies.

## Writer handoff

The host passes accepted findings to the Writer as a complete `HOST_REVIEW_FINDINGS_V1` packet with version `writer-review-feedback-v1`, the exact candidate `testHash`, all normalized `findings` including their bases, and the current AST `methodScope`. Its mode is `preserve-method-set` unless a finding identifies a missing scenario; `allow-additions` still preserves the existing baseline and quality gates. Missing AST inventory, a mismatched hash, changed findings or an inconsistent scope blocks the handoff.

This packet bypasses the 3500-character summary used for unstructured execution/structure diagnostics. The final request budget must fit the entire packet, candidate and necessary evidence or reject the request. The packet does not approve a correction, a new scenario, a changed fixture or mutation measurement. Findings without missing scenarios that cite existing test methods now use [source-bound method replacement](writer-method-edits.md). Mixed/missing-scenario and general structure/fixture revision paths remain subsequent generalization work.
