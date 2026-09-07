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
npm run test:unit
npm run compile
```

Use `F5` in VS Code to start an Extension Development Host for manual UI work.
Do not use a production cloud API key in automated tests.

## Change expectations

1. Keep a change focused: one observable behavior or one documentation unit.
2. Add a regression test for both the supported case and the closest unsafe or
   ambiguous case where applicable.
3. Run `npm run test:unit`, `npm run compile`, and `git diff --check`.
4. Update `CHANGELOG.zh-TW.md` in Traditional Chinese with the change,
   verification, and known limitations.
5. Use a commit subject containing English and Traditional Chinese.

Generated tests must be validated by executable evidence. Do not weaken target
invocation checks, isolated I/O rules, mutation baselines, or exception-evidence
requirements merely to accept more model output.

## Pull requests

Describe the user-visible result, tests run, affected provider/Tier, and any
remaining limitations. Keep API keys and full model responses out of PR text.
For UI changes, include a redacted screenshot or a clear manual verification
description.
