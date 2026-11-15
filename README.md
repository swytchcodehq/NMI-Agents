# NMI Agents

AI agents for the [NMI](https://www.nmi.com) payment gateway. Every NMI call goes through [Swytchcode](https://docs.swytchcode.com), which handles auth, retries, validation and policy, so no agent has a hand-written HTTP client.

Each agent is a self-contained Swytchcode project in its own folder, with its own allow-list, policies and credentials. One agent's folder can't load another's configuration.

## Agents

| Folder | What it does | Status |
|---|---|---|
| [`nmi-daily-close-agent/`](nmi-daily-close-agent/) | Read-only agent that reconciles NMI activity against a ledger and bank deposits, then writes a daily close report | Phase 1 of 8: Swytchcode configured, no agent code yet |

## Getting started

Open an agent's folder and follow its README. Run every `swytchcode` command from inside that folder. The CLI uses the nearest `.swytchcode/` directory, so the folder you run from decides which project's allow-list and policies apply.
