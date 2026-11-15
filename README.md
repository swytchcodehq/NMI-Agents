# NMI Agents

A read-only finance agent that reconciles NMI payment gateway activity and produces a daily close report. It's a reference demo for developers evaluating NMI. Every NMI call goes through [Swytchcode](https://docs.swytchcode.com), which sits between the agent and the API and handles auth, retries, validation and policy. There's no hand-written HTTP client.

> **Status: Phase 1 (inspect and configure) is in progress.** The Swytchcode project is configured but no agent code exists yet. Work is paused at the Phase 1 checkpoint, which needs one successful sandbox query and a few open decisions (see [Open decisions](#open-decisions)).

## Stack

- **Language:** TypeScript on Node.js 22
- **Agent:** OpenAI Agents SDK (`@openai/agents`) through the Swytchcode adapter `@swytchcode/runtime/providers/openai-agents`
- **API execution:** Swytchcode CLI 2.27.0 with the NMI provider `nmi.nmi@1.0.0`
- **Money:** decimal arithmetic only, never floating point

## What the agent will do

For a close date D in the merchant's timezone, the agent will:

1. **Fetch.** Query everything modified from D minus 3 days through the end of D, converted to UTC, paging until a short page comes back.
2. **Normalize.** Turn NMI's XML into typed records: transaction ID, order ID, type, condition, currency, decimal amounts, and the dated `<action>` history.
3. **Reconcile.**
   - **Gateway vs ledger:** match against `data/ledger.csv` on order ID and amount. Flag rows missing from either side, amount mismatches and duplicates.
   - **Settlement:** group transactions settled on D by `batch_id`, with counts and totals per currency. Flag stale `pendingsettlement` (older than 24h), failures, refunds (including partial refunds) and voids.
   - **Batches vs bank:** match batch totals to `data/bank_deposits.csv` within a configurable tolerance, since deposits arrive net of fees.
4. **Report.** Write `out/close-YYYY-MM-DD.json`, `exceptions.csv` and a Markdown report. Every API call is logged to `out/audit.jsonl`, with the key removed. Re-running the same date on the same data gives byte-identical JSON and CSV.
5. **Explain.** An LLM writes a short summary plus a likely cause and next step for each exception. Every number it uses must come from the JSON, and a test checks that.

A separate `seed/` project, with its own Swytchcode config and key, will create about 30 sandbox transactions plus matching ledger and bank files with planted discrepancies. It's the only part of the repo that writes to NMI.

## Swytchcode configuration (done so far)

All of this lives in `.swytchcode/`. Inspect it with the CLI rather than reading the files:

```powershell
swytchcode list tooling
swytchcode policy list
swytchcode doctor
```

### Allow-list (`tooling.json`)

The only enabled method is `nmi_payments.query.php.create`, the NMI Query API. The mode is `sandbox`.

### Endpoints and execution (`integrations/manifest.json`)

| Setting | Value |
|---|---|
| Sandbox endpoint | `https://sandbox.nmi.com/api` (the bundle shipped with `http://localhost`) |
| Production endpoint | `https://secure.nmi.com/api` |
| Retries | 3, exponential backoff 1s → 2s → 4s, capped at 8s |
| Retried statuses | 429, 500, 502, 503, 504 |
| HTTP timeout | 30s per attempt, 120s total |
| Concurrency | 1 |
| Response size cap | Off. The 100 KB default would truncate large XML pages |

### Policies (`integrations/policies.json`)

`swytchcode policy validate` accepts these rules. They haven't been run against a live call yet.

| ID | Blocks a query when | Why |
|---|---|---|
| `p1-deny-report-type` | `report_type` is set | Report types open the customer vault, recurring billing and profile data, which a close doesn't need |
| `p2-deny-pii-filters` | It filters on `cc_number`, `first_name`, `last_name`, `email`, `phone`, `fax`, `address1`, `city`, `state`, `zip` or `drivers_license_*` | The agent must never search by cardholder data |
| `p3-require-date-window` | There's no `transaction_id` and either `start_date` or `end_date` is missing | Every list query must be time-bounded |
| `p4a-require-result-limit` | `result_limit` is missing | No unbounded result sets |
| `p4b-max-result-limit` | `result_limit` is above 500 | Caps page size |

## Setup

1. Install the [Swytchcode CLI](https://docs.swytchcode.com) and run `swytchcode login`.
2. Fetch the NMI bundle. It isn't committed, because it's re-fetched from the registry:
   ```powershell
   swytchcode bootstrap
   ```
3. Connect a credential. The CLI won't run the method without one, even though NMI ignores it (see the notes below):
   ```powershell
   swytchcode auth connect nmi
   ```
4. Run a test query using a **private** security key from an NMI **sandbox test merchant account** (Settings → Security Keys, with Query API access):
   ```powershell
   $env:NMI_QUERY_KEY = "<private sandbox security key>"
   swytchcode exec nmi_payments.query.php.create --raw --input "security_key=$env:NMI_QUERY_KEY" --input result_limit=50 --input start_date=20261106000000 --input end_date=20261113235959
   ```

When the agent exists, its settings will go in a `.env` file that is never committed:

```
OPENAI_API_KEY=...
OPENAI_MODEL=...
NMI_QUERY_KEY=...
APP_ENV=sandbox
```

## Things we learned about NMI and Swytchcode

- **The key goes in the body.** The bundle sends the managed credential as an `Authorization` header, and NMI's classic Query API rejects that with "Authentication Failed". The key has to be sent as the `security_key` form field.
- **Responses are XML.** By default, `swytchcode exec` expects JSON and fails on XML. Use `--raw`, which returns NMI's reply untouched in a `body` field.
- **Errors come back as HTTP 200.** NMI returns failures as `<error_response>` with status 200, so every response body has to be checked.
- **Credentials are checked before policies.** The CLI checks for a connected credential before it evaluates policies, even with `--dry-run`, so policy tests need a connected credential.
- **Close stdin when scripting.** In scripts, `swytchcode exec` waits on stdin. Run it with stdin closed (`</dev/null`).
- **Don't use `--verbose` with a key in the body.** It hides the `Authorization` header but not body fields, so `security_key` would appear in logs.
- **Date filters use last-modified time.** `start_date` and `end_date` filter on when a transaction was last changed, so each transaction is classified by the dates on its `<action>` blocks.
- **NMI has no idempotency keys.** The Payment API only checks for duplicates on amount plus payment data (`dup_seconds`), which doesn't make retries safe. The docs we read don't state the default value.

## Open decisions

The spec asks for these as Swytchcode settings, but the documented schema can't express them. Per the spec, they aren't approximated in code. Each one needs a decision:

| Requirement | Gap |
|---|---|
| Budget of 200 calls per run | No per-run budget. Policy rate limits use rolling time windows |
| Deny date windows longer than 7 days | Policies can't compare one field with another, and NMI's `YYYYMMDDhhmmss` dates aren't RFC3339 |
| Deny hosts other than sandbox unless `APP_ENV=production` | An env var can only be a policy value, not a condition on its own. The closest real settings are `permissions.network` plus the tooling mode |
| Retries on 429/5xx for the query | `query.php` is a POST, and Swytchcode only retries a POST that carries an idempotency key. Turning on `"dynamic"` idempotency would enable retries; NMI ignores the header |
| Seed idempotency keyed on `order_id` | Swytchcode keys are random per call, and nothing stores them or removes duplicates for providers without idempotency support. As documented, a retried sale after a timeout could still create a second NMI transaction |

## Roadmap

- [ ] **Phase 1:** inspect and configure Swytchcode (checkpoint: one real sandbox query)
- [ ] **Phase 2:** fetch and normalize, including a `--fixtures <dir>` mode with saved XML
- [ ] **Phase 3:** reconcile with pure, unit-tested functions
- [ ] **Phase 4:** JSON, CSV and Markdown reports plus the audit log
- [ ] **Phase 5:** OpenAI agent with `run_close` and `lookup_transaction` tools
- [ ] **Phase 6:** one test per policy, plus an allow-list test
- [ ] **Phase 7:** seed project (the only part that writes)
- [ ] **Phase 8:** demo run and full docs

## Safety

- No secrets in code, logs or fixtures.
- Card data is masked in all output.
- Text in the ledger and bank CSVs is treated as data, never as instructions.
- A policy denial is final: it's logged, listed as an exception, and never retried or rephrased.
