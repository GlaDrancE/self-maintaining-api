# sma documentation

Documentation for `sma`, the tool in this repository. Everything here is derived
from the source in `sma.mjs` and `src/`. Where the code leaves something
undefined, the doc says so rather than guessing.

| Doc | Read it when |
|---|---|
| [getting-started.md](getting-started.md) | You are installing sma for the first time and want a working detection on a real spec. |
| [configuration.md](configuration.md) | You are writing or debugging `watch.yaml`, or you need the environment variable list. |
| [cli.md](cli.md) | You need the exact synopsis, inputs, outputs and exit code of one command. |
| [how-it-works.md](how-it-works.md) | You want to know what happens between "spec changed" and "PR opened", and why it was built that way. |
| [rules.md](rules.md) | You are looking at a rule id in a report and want to know what fired it and what it breaks. |
| [ci.md](ci.md) | You are wiring sma into GitHub Actions, GitLab CI or Jenkins. |
| [troubleshooting.md](troubleshooting.md) | sma printed something you did not expect, or detected nothing when it should have. |
| [faq.md](faq.md) | You are deciding whether to adopt it: cost, privacy, language support, scope limits. |

## Operating the tool

These cover adoption and the project's own direction rather than the reference
surface above.

| Doc | Read it when |
|---|---|
| [pilot-plan.md](pilot-plan.md) | You are evaluating sma and want a staged path from report-only to `--fix`. |
| [onboarding-a-project.md](onboarding-a-project.md) | You are adding sma to another repository and want a checklist. |
| [productionization.md](productionization.md) | You are moving from a working install to something you rely on daily. |
| [roadmap.md](roadmap.md) | You want to know what is not built yet and in what order. |

The project README is one directory up: [../README.md](../README.md).
