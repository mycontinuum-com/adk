# Contributing

Thanks for your interest in the ADK. A few things about this repository are unusual, and knowing them will save you time.

## How this repository works

The ADK is developed inside Anima's monorepo; this repository is a continuously exported snapshot of it. Every commit here corresponds to a change that already passed our internal review and CI. Nobody — including Anima engineers — merges directly to `main` here.

What that means for contributions:

- **Issues are the front door.** Bug reports, design questions, and feature requests are all welcome and are read by the people who actually develop the ADK.
- **Pull requests are imported, not merged.** When we accept a PR, we apply your patch inside the monorepo with your authorship preserved, run it through our gates, and it flows back out here as a commit authored by you — under your GitHub noreply address, so it links to your profile and counts toward your contributions. Your PR is then closed with a link to that commit. This is the normal, successful path — a closed PR with a linked commit is a merged PR.
- **Releases are tagged here** and published to npm from this repository via trusted publishing, behind a maintainer approval gate.

## Before you open a PR

- Check the **Stability** section of the README. The experimental surfaces change without deprecation cycles, and PRs against them may be overtaken by design changes.
- The ADK is pre-1.0 and favors one clear API over compatibility aliases. A PR that adds a second way to do something will usually be declined on principle, however well built — open an issue about the _first_ way instead.
- Tests are the argument. The suite runs with no API keys and no database (`pnpm install`, `pnpm run test`); the Postgres compliance suites additionally run against any `DATABASE_URL`. A behavior change without a test rarely survives import.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

Node ≥22 and pnpm (pinned via `packageManager`) are required.
