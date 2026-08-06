# Security Policy

This repository is a satellite / example application built on the
[Suwappu API](https://github.com/0xSoftBoi/suwappubot). Some examples can
initiate real financial transactions when execution is enabled. Treat API keys,
wallet credentials, and configuration as sensitive.

## Reporting a vulnerability

**Do not open a public issue for security reports.** Instead:

- Use **GitHub Private Vulnerability Reporting** when it is enabled for this repository, or
- Email **security@suwappu.bot**.

Please include the affected file, version or commit, reproduction steps, and an
impact assessment.

**Scope note:** issues in this repository's own code, SDK usage, dependencies,
or CI belong here. Vulnerabilities in the Suwappu API, core bot, smart
contracts, custody/key-management layer, or shared SDK should be reported
upstream through the
[core security policy](https://github.com/0xSoftBoi/suwappubot/security/policy).

## Custody and execution model

Suwappu supports both self-custody and custodial product flows. This satellite
repository does not make a custody guarantee: behavior depends on the API mode
and configuration in use. Prefer dry-run or read-only modes where available,
use test wallets before enabling execution, and never commit credentials.

## Our commitment

- **Acknowledge** reports within 3 business days.
- **Triage and severity** within 7 business days.
- **Coordinate disclosure** with the reporter and provide credit unless
  anonymity is requested.

## Safe harbor

Good-faith research conducted under this policy, without privacy violations,
data destruction, or service degradation, will not result in legal action from
us. If in doubt, contact us before testing.
