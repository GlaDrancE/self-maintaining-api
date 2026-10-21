# Market research: does anyone need this?

Researched 2026-10-18. Every claim links to its source. Things that could not be
verified are marked **unverified**.

## The short answer

Yes, with a clear scope. Large API providers publish their OpenAPI specs in public,
actively updated GitHub repos, and those specs really do lose endpoints and gain
required parameters. Every established diff tool serves the **provider**, who checks
their own API before shipping it. No established tool watches **someone else's**
spec, finds the affected call sites in **your** code, and opens a verified patch.
That is the gap sma fills.

## 1. Providers publish specs a consumer can watch

| Provider | Spec | Format | Activity (30 days to 2026-10-18) |
|---|---|---|---|
| Stripe | [stripe/openapi](https://github.com/stripe/openapi) | OAS 3.0 | 100+ commits, several a day |
| GitHub | [github/rest-api-description](https://github.com/github/rest-api-description) | OAS 3.0.3, date-versioned files | 100+ commits |
| OpenAI | [openai/openai-openapi](https://github.com/openai/openai-openapi) | OAS 3.1 | Many a day; October commits include "Remove compute_units field" |
| Cloudflare | [cloudflare/api-schemas](https://github.com/cloudflare/api-schemas) | OAS 3.0.3 | 100+ commits |
| DigitalOcean | [digitalocean/openapi](https://github.com/digitalocean/openapi) | OAS 3.0 | 36 commits |
| Asana | [Asana/openapi](https://github.com/Asana/openapi) | OAS 3.0 | 16 commits |
| Plaid | [plaid/plaid-openapi](https://github.com/plaid/plaid-openapi) | OAS 3.0, one file per API version | 5 commits |
| Twilio | [twilio/twilio-oai](https://github.com/twilio/twilio-oai) | OAS 3.0.1 | 4 commits, in release batches |
| Box | [box/box-openapi](https://github.com/box/box-openapi) | OAS 3.0.2 | 3 commits |
| Kubernetes | [kubernetes/api/openapi-spec](https://github.com/kubernetes/kubernetes/tree/master/api/openapi-spec) | Swagger 2 + OAS 3 | Changes with each release |
| ~2,500 APIs | [APIs.guru directory](https://github.com/APIs-guru/openapi-directory) | OAS 2/3 | Community-maintained |

Slack's [spec repo](https://github.com/slackapi/slack-api-specs) is archived (last
push 2021). Don't watch it.

## 2. What already exists, and on which side

| Tool | What it does | Side | Patches consumer code? |
|---|---|---|---|
| [oasdiff](https://www.oasdiff.com/) | Diffs two specs with hundreds of checks; GitHub Action | Provider CI gate | No |
| [Optic](https://github.com/opticdev/optic) | Spec diff and governance. Acquired by Atlassian, repo archived | Provider | No |
| [openapi-diff](https://github.com/OpenAPITools/openapi-diff) | Spec diff CLI | Provider | No |
| [Bump.sh](https://bump.sh) | Hosted docs plus a breaking-change changelog | Provider publishes; consumer gets notified | No |
| [Speakeasy](https://speakeasy.com/docs/versioning), [Fern](https://buildwithfern.com), APIMatic, [Stainless](https://www.stainless.com/blog/stainless-is-joining-anthropic) | Generate SDKs from a spec | Provider | No. The consumer still bumps the SDK and fixes the errors |
| [Dependabot](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories), [Renovate](https://docs.renovatebot.com/modules/manager/regex/) | Bump package versions | Consumer, packages only | No |
| [Pact](https://docs.pact.io/getting_started/what_is_pact_good_for) | Consumer-driven contract tests | Needs both sides; its own docs say it is a poor fit for public APIs | No |
| [SelfHeal](https://www.producthunt.com/p/selfheal/selfheal), [Twin](https://twin.so/blog/why-your-zapier-and-n8n-workflows-keep-breaking-and-what-sel/) | Repair their own platform's connectors after a runtime failure | Consumer, inside their platform | Their connectors only, after the break (claims self-reported) |

sma moves oasdiff's job to the consumer side and adds call-site mapping, an agent
patch, independent verification, and a PR.

## 3. The problem is real

- **Providers break without warning.** In 3,075 OpenAPI histories, only 517 APIs
  consistently signalled breaking changes with a major version bump
  ([Serbout & Pautasso, ICWE 2024](https://design.inf.usi.ch/sites/default/files/biblio/apiace-icwe2024.pdf)).
  Breaking changes were 2.44 times as frequent as non-breaking ones
  ([Serbout, PhD thesis](https://design.inf.usi.ch/sites/default/files/biblio/Souhaila_Serbout_PhD_Thesis.pdf)).
- **Deprecation is not a reliable warning.** Only 5.2% of explicitly deprecated
  operations were later removed. Removals mostly happen with no deprecation first
  ([Di Lauro et al., ECSA 2022](https://oas-search.inf.usi.ch/pdf/ecsa-2022.pdf)).
- **Changes go wrong.** In Postman's 2024 survey, only 56% of API changes succeed
  with minimal issues
  ([State of the API 2024](https://www.postman.com/state-of-api/2024/api-production)).
- **Sunset policies force migrations.** Facebook Graph API versions
  [expire two years](https://developers.facebook.com/docs/graph-api/guides/versioning/)
  after their successor ships. Google Universal Analytics
  [shut off its API](https://support.google.com/analytics/answer/11583528) in July 2024.

Twitter/X (2023) and Reddit (2023) broke many third-party apps, but those were
pricing and access changes, not schema changes. No spec diff would have helped.

## 4. Academic backing for the design

- Espinha, Zaidman, Gross, [Web API growing pains](https://research.tudelft.nl/en/publications/web-api-growing-pains-stories-from-client-developers-and-their-co) (JSS 2015).
  Client developers describe the cost of keeping up with web API evolution.
- Espinha et al., [Web API Fragility](https://arxiv.org/pdf/1407.4266).
- Almeida, Xavier, Valente, [Automatic Library Migration Using LLMs](https://arxiv.org/abs/2408.16151).
  A [follow-up with an agentic setup](https://arxiv.org/pdf/2510.26699v2) reached
  a median test-pass rate of only 39.75%.
- Islam et al., [LLMs on PyMigBench](https://arxiv.org/abs/2504.13272).
  89–94% of individual edits were correct, but far fewer migrations passed the
  original tests.

The last two are why sma never trusts the agent's own report. The harness runs the
tests itself and checks the changed files against the predicted impact.

## 5. Reproduced on a real API

`npm run demo:real` replays OpenAI's commit
[`d9c3021a`](https://github.com/openai/openai-openapi/commit/d9c3021a243c502a902d71c88b60800151425bf7)
(2023-06-19, "remove disabled/deprecated endpoints") against a small app written for
the earlier API. sma reports all 5 removed endpoints and maps 2 of them (`/engines`,
`/answers`) to the app's call sites, including the helper in `bot.js` that calls them
one hop away. The other 3 are correctly reported as not affecting this repo.

A second real change also reproduces. In commit
[`c012b5cc`](https://github.com/openai/openai-openapi/commit/c012b5cc554b0a23ffcf1c41cca6ae37387dd865),
OpenAI made `prompt` required on `POST /completions`:

```bash
npx sma diff \
  https://raw.githubusercontent.com/openai/openai-openapi/9ce93317c4cfd7bd48ab376f128fcf09ff3f09d8/openapi.yaml \
  https://raw.githubusercontent.com/openai/openai-openapi/c012b5cc554b0a23ffcf1c41cca6ae37387dd865/openapi.yaml
# [breaking] PARAM_MADE_REQUIRED  POST /completions
#     body parameter 'prompt' is now required
```

The real spec also exposed noise the synthetic demo never would. Top-level `x-*`
vendor extensions (OpenAI's `x-oaiMeta` docs metadata) were 4 of the first 9
reported changes, so they are now ignored.

## Honest limits

- **Coverage.** Many APIs publish no spec at all (Twitter/X, Reddit).
- **Spec quality.** A spec can lag behind production. APIs.guru
  [reports](https://apis.guru/about) that about 80% of the definitions it collects
  needed fixes.
- **Versioned APIs.** Stripe
  [pins each account to a version](https://stripe.com/blog/api-versioning), and
  GitHub and Plaid publish per-version files. Watch the file for the version you are
  pinned to, or you will be alerted about changes that cannot reach you.
- **SDK users.** Teams that call an official SDK rather than raw HTTP mostly need
  Dependabot plus a codemod. sma's SDK matching is a heuristic.
- **Wrong kind of break.** Pricing changes, shutdowns and auth policy changes are
  outside what any spec diff can see.

**Positioning:** Dependabot for raw-HTTP integrations against fast-moving APIs
that publish specs (OpenAI, Cloudflare, DigitalOcean, Twilio, Box, Asana). It is
not a universal fix for third-party API breakage.

**Unverified:** that Postman acquired Fern; a vendor claim that "over 30% of downtime
comes from external API changes"; SelfHeal's capability claims.
