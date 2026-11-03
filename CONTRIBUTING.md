# Contributing

Thank you for helping improve LLM Unit Test & Mutation Analyzer.

## Before you start

- Read [PROJECT_RULES.md](PROJECT_RULES.md). It defines the evidence-first
  constraints for AST, Dynamic Trace, prompts, generated tests, and mutation
  scoring.
- Do not add provider-, model-, or business-domain-name special cases. New
  behavior must be driven by AST, Dynamic Trace, or an evidence-bound Skill
  Card.
- Never commit credentials, `.env` files, test-project private data, or local
  execution logs.

## Local setup

```bash
npm ci
python -m pip install -r requirements.txt
npm run test:fast
```

Use `F5` in VS Code to start an Extension Development Host for manual UI work.
Do not use a production cloud API key in automated tests.

## Change expectations

1. Keep a change focused: one observable behavior or one documentation unit.
2. Add a regression test for both the supported case and the closest unsafe or
   ambiguous case where applicable.
3. Start with focused regressions, then run `npm run test:fast` and
   `git diff --check`. For pipeline changes, also run the affected integration
   tests. Run `npm run test:full` at a milestone or before a demo/release.
4. Update `CHANGELOG.zh-TW.md` in Traditional Chinese with the change,
   verification, and known limitations.
5. Use a commit subject containing English and Traditional Chinese.

Generated tests must be validated by executable evidence. Do not weaken target
invocation checks, isolated I/O rules, mutation baselines, or exception-evidence
requirements merely to accept more model output.

## Verification entry points

| Command | Scope |
| --- | --- |
| `npm run test:fast` | Strict TypeScript, lint, explicit low-cost Node/Python suites and Webview syntax. |
| `npm run test:integration` | Remaining Node/Python suites, including real workers, Trace, mutation and batch workflows. |
| `npm run test:full` | All Node/Python suites, Webview, tracked/history secret scan and production build. |
| `npm run test:related -- --node reviewerCommunicationContract --python test_review_test_facts` | Only matching test files, after test compilation. Repeat either selector to add files. |

Append `-- --list` to preview a tier without executing checks. For example,
`npm run test:full -- --list`. Selectors match repository test files; an empty
related selection or an unmatched selector fails instead of reporting success.
Use test names or test paths, rather than a production source path.

Fast and integration test-file sets are disjoint and together cover the full
inventory. New Node suites default to integration until reviewed for the fast
list. No test is removed or skipped because of its historical duration.
`test:unit` remains a compatibility alias for full verification; the existing
Node and Python runner commands without arguments still run their complete
respective inventories. The VS Code/Mocha tests remain under `npm test`.

Record the exact tier and selectors run. Passing a focused or fast selection
does not establish a full-suite pass, and fixed-response integration tests do
not establish live-model quality.

## Pull requests

Describe the user-visible result, tests run, affected provider/Tier, and any
remaining limitations. Keep API keys and full model responses out of PR text.
For UI changes, include a redacted screenshot or a clear manual verification
description.
