# KNHB Match Center for Switchboard

A standalone, read-only Switchboard plugin for personal hockey matches, referee duties, favorite teams, schedules and results.

Install **`tader/switchboard-plugin-knhb`** from Switchboard’s Plugins page, then add a **KNHB Match Center** connection. Until the first release is published, explicitly select the `main` development branch; after publication use Latest release.

Choose **Sign in with KNHB** to open KNHB’s website in a separate Chrome or Edge window on the computer running Switchboard. Click **Inloggen**, complete the normal KNHB login, and return to Match Center. Switchboard finishes connecting and closes the temporary browser. No OAuth app registration or password entry in Switchboard is required. A desktop session is needed on that computer. For a remote/headless server, use **Import signed-in KNHB session**; see the [connection guide](docs/connecting.md). Public club/team data is also available without an account.

The plugin exposes eight API operations through Switchboard’s normal API reference and agent tools:

| Operation | Purpose |
| --- | --- |
| `getMyMatches` | Account match feed, including roles and required actions |
| `getFavorites` | Account’s favorite teams, competitions and clubs |
| `listClubs` / `getClub` | Discover clubs and their current teams |
| `getTeamPoule` | Team schedules, results and available competition phases |
| `getMatch` | Match details, including available location/official data |
| `getDefaultFavorites` / `getDefaultMatches` | Public curated feeds, clearly distinct from personal favorites |

Ask an agent “What are our hockey matches this weekend?”, “Which matches do I referee?”, or “How did we last play against HDM?”. For family schedules, add each child’s teams to your KNHB favorites and check that the intended teams appear. KNHB controls what linked-family information your account can access. The plugin does not infer assignments from team membership. Previous results are bounded by what KNHB returns for the selected teams and competition phases.

An agent can use these details with an existing calendar connection when you ask it to update the family calendar. This plugin does not write calendar events or run automatic synchronization. See [using match data](docs/matches.md) for deduplication, cancellation and time rules.

Authentication tokens and device credentials are stored by Switchboard in its encrypted connection store. The sign-in browser uses a new private temporary profile and an OS debugging pipe, and exports only the KNHB OIDC token record. It closes and deletes the profile on success, failure, plugin unload, or after ten minutes. Cancelling a connect dialog leaves the browser until that timeout. A hard process termination can leave a temporary `switchboard-knhb-*` directory in the OS temp folder; remove it when Switchboard is stopped. Existing personal browser profiles are never opened by the plugin. Tokens are refreshed when KNHB provides a usable refresh token; otherwise reconnect when sign-in expires. Imported sessions are credentials: never paste them in chats or commit them.

## Development

Node.js 24 or newer; no runtime dependencies or build step.

```sh
npm ci
npm run check
```

Tests cover the v8 signing algorithm, verified JWT identities, session import, refresh rotation, credential boundaries, read-only enforcement and browser extraction. They use mocked responses and synthetic identities. Live anonymous smoke checks are recorded in [API findings](docs/api-findings.md); personal login requires an interactive KNHB account and is not exercised by CI.

Release Please maintains the version and changelog. Every push and PR runs `check`. The release workflow explicitly dispatches that same workflow on Release Please branches so its required check runs without manual workflow approval. `main` requires an up-to-date passing `check`, a PR and resolved conversations, including for administrators; no approving review is required.

This is an unofficial integration using endpoints observed in KNHB’s public web client. KNHB can change its API or authentication; it is not a documented third-party API contract. This repository contains no copied hockey-timer fixtures, personal accounts or credentials.
