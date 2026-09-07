# Security Policy

## Supported versions

Until the first stable release, security fixes are applied to the current `main`
and active development branches. Please update to the newest available release
before reporting an issue.

## Reporting a vulnerability

Do **not** open a public issue for a suspected vulnerability and do not include
an API key, token, password, private source code, full authorization header,
or customer data in any report.

Use GitHub's private vulnerability reporting feature when it is enabled for
this repository. If it is unavailable, contact the repository owner through
the GitHub profile and provide:

- A concise description of the impact.
- Minimal, non-sensitive reproduction steps.
- Affected extension version, OS, Python version, and provider type.
- Any suggested mitigation, if known.

Please allow the maintainer reasonable time to investigate and prepare a fix
before public disclosure.

## Credential exposure

If an API key or token was committed, pasted into a public discussion, or sent
to an untrusted service, treat it as compromised immediately:

1. Revoke or rotate it at the provider.
2. Remove it from current files and replace it with a secret reference.
3. Report the location without reproducing the secret value.
4. Assess Git history and provider audit logs as appropriate.

`.gitignore` and the CI secret scanner help prevent accidents, but neither can
make an already disclosed credential safe again.
