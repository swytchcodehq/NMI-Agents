# NMI record assistant

A terminal assistant for the [NMI](https://www.nmi.com/) payment gateway. You describe a record in plain English, and it finds the record and tells you its status.

```
> what happened to John Smith's order last week?
  ↳ searching NMI {"first_name":"John","last_name":"Smith","start_date":"20261106000000","end_date":"20261113235959","result_order":"reverse","result_limit":10}
Order 1234567890 is complete: $11.00 sale on 12 Nov (approved, SUCCESS), settled the next day.
No refunds or voids on it.
```

It finds:
- **Transactions**, by transaction ID, order ID, name, email, phone, address, last 4 card digits, action type (sale, refund, void...), status, source or date range
- **Stored customers** (customer vault)
- **Subscriptions** and **recurring plans**
- **Invoices**, including by invoice status

It is **read-only**. The only NMI method it can call is the Query API, so it cannot charge, refund, void or change anything.

## How it works

```
 you ──► OpenAI model (Responses API) ──► nmi_query tool ──► Swytchcode ──► NMI Query API
          turns your description           validated          injects NMI auth,
          into search filters,             filters            applies policies,
          explains the result ◄─────────────────────────────── returns the XML result
```

- **[Swytchcode](https://www.swytchcode.com)** runs every NMI call. There is one tool: `nmi_payments.query.php.create` (NMI Query API, `POST /query.php`).
- The tool's filters are read at startup from that method's Swytchcode contract (`swytchcode info`). The model can only send fields NMI defines, using NMI's allowed values for fields such as `condition`, `report_type` and `invoice_status`.
- Before anything is sent, the app checks the filters. Card searches must be exactly 4 digits, and dates must be in `YYYYMMDDhhmmss` format.
- **NMI credentials never touch this code.** Swytchcode stores them and adds them to each request.
- OpenAI requests use `store: false`, so OpenAI doesn't keep the payment data in its stored responses.

## Prerequisites

- Node.js 22 or later (uses `process.loadEnvFile`)
- The [Swytchcode CLI](https://docs.swytchcode.com/cli/overview/) 2.27 or later, signed in with `swytchcode login`
- An OpenAI API key
- An NMI **test account** security key. Don't use a live merchant key while testing.

## Setup

```bash
git clone https://github.com/<you>/nmi-agents.git
cd nmi-agents
npm install

# Download the NMI bundle that tooling.json expects
swytchcode bootstrap

# NMI key: Swytchcode stores it encrypted. It does not go in .env.
swytchcode auth connect nmi

# OpenAI key: goes in .env
cp .env.example .env
#   then edit .env and set OPENAI_API_KEY=sk-...

swytchcode doctor     # optional: checks the setup
```

### Where the keys go

| Key | Where | Why |
|---|---|---|
| `OPENAI_API_KEY` | `.env` (ignored by git) | Read by the OpenAI SDK |
| NMI security key | `swytchcode auth connect nmi` | Swytchcode stores it and adds it to every NMI call. The app never reads it. |

## Usage

```bash
npm start                                   # interactive chat
npm start -- "status of order 1234567890"   # one question, then exit
```

In chat, type `/new` to start a new conversation and `exit` to quit.

Example questions:

- `status of transaction 2612675976`
- `did the refund for jane@example.com go through?`
- `failed card payments yesterday ending in 1111`
- `is invoice 88 paid?`
- `what's the state of subscription 7345120?`
- `customers named Patel in the vault`

### What the answer contains

- **Transactions:** the overall `condition` (pending, pendingsettlement, in_progress, complete, failed, canceled, abandoned, unknown), then each action in date order. For each action: type, amount, date, whether it succeeded, and NMI's response text.
- **Invoices:** their status (open, paid, closed, past_due).
- **Subscriptions and customers:** what the record shows about their state.
- **Several matches:** a short table, then it asks which one you mean.

Card numbers are never shown in full.

## Configuration

All settings are optional except `OPENAI_API_KEY`. Set them in `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none (required) | OpenAI API key |
| `OPENAI_MODEL` | `gpt-5` | Any OpenAI reasoning model that supports the Responses API |
| `ASSISTANT_EFFORT` | `medium` | Reasoning effort: `minimal`, `low`, `medium` or `high` |
| `SWYTCHCODE_BASE_URL_NMI_NMI_SANDBOX` | `https://sandbox.nmi.com/api` | NMI base URL Swytchcode uses in sandbox mode |

The project ships in Swytchcode **sandbox** mode, set in `.swytchcode/tooling.json`. Switch to production only on purpose, with a production base URL (`https://secure.nmi.com/api`) and production credentials.

Built-in limits, set as constants in `src/assistant.ts`:

| Limit | Value |
|---|---|
| NMI lookups per question | 8 |
| Records per lookup (when the model doesn't set `result_limit`) | 25 |
| Characters of a result passed to the model | 60,000 |
| Retries on transient network errors (reads only) | 3 |

## Search filters

The model chooses from these Query API fields. **All are optional** and combine with AND. They come from the Swytchcode contract for `nmi_payments.query.php.create`.

| Field | Values / format |
|---|---|
| `transaction_id`, `order_id`, `invoice_id`, `subscription_id`, `customer_vault_id`, `partial_payment_id` | IDs |
| `first_name`, `last_name`, `email`, `phone`, `fax`, `address1`, `city`, `state`, `zip` | Customer details |
| `cc_number` | Last 4 digits only |
| `order_description`, `merchant_defined_field_1` | Free text |
| `drivers_license_number`, `drivers_license_dob`, `drivers_license_state` | Driver's license details |
| `condition` | `pending` `pendingsettlement` `in_progress` `abandoned` `failed` `canceled` `complete` `unknown` |
| `transaction_type` | `cc` (card) `ck` (check) `cs` (cash) |
| `action_type` | `sale` `refund` `credit` `auth` `capture` `void` `return` `validate` |
| `source` | `api` `batch_upload` `mobile` `quickclick` `quickbooks` `recurring` `swipe` `virtual_terminal` `internal` |
| `start_date`, `end_date` | `YYYYMMDDhhmmss`, UTC |
| `date_search` | `created` `updated` |
| `report_type` | `receipt` `customer_vault` `recurring` `recurring_plans` `invoicing` `gateway_processors` `account_updater` `test_mode_status` `profile` (omit for transactions) |
| `invoice_status` | `open` `paid` `closed` `past_due` |
| `result_limit`, `page_number` | Integers (paging) |
| `result_order` | `standard` (oldest first) `reverse` (newest first) |
| `mobile_device_license`, `mobile_device_nickname` | Mobile device filters |
| `processor_details` | Processor details filter |

`security_key` is deliberately not offered to the model, because Swytchcode handles authentication.

## Project layout

```
src/assistant.ts         the assistant: tool schema, validation, Swytchcode calls, OpenAI loop
.swytchcode/tooling.json Swytchcode allow-list (the one enabled NMI method, sandbox mode)
skills.md                Swytchcode agent skill file (https://www.swytchcode.com/skills.md)
CLAUDE.md                Swytchcode rules for coding agents working in this repo
.env.example             environment template
```

## Troubleshooting

| Message | Fix |
|---|---|
| `NMI is not connected` | `swytchcode auth connect nmi` |
| `OPENAI_API_KEY is not set` | Copy `.env.example` to `.env` and add the key |
| `OpenAI model "..." not available` | Set `OPENAI_MODEL` to a model your key can use |
| `NMI base URL is not set` | Set `SWYTCHCODE_BASE_URL_NMI_NMI_SANDBOX` in `.env` |
| Tool not found / not enabled | `swytchcode bootstrap`, then `swytchcode list tooling` |
| `Authentication Failed` from NMI | Check the connected key belongs to the account behind the base URL (a test key needs the sandbox URL) |
| Anything else | `swytchcode doctor`, then `swytchcode audit` for recent calls |

## Known limitations

- **Response size:** the NMI bundle's manifest caps responses at 100 KB by default, so a very broad search can be cut off. Narrow the filters, or lower `result_limit`.
- **Auth:** the NMI bundle sends the key as an `Authorization` header. If NMI rejects it, the bundle's auth setup needs adjusting in Swytchcode, not in this code.
- **Dates:** the contract lists dates as `date-time`, but NMI uses `YYYYMMDDhhmmss` (as in the contract's example response), so that's what this app sends.
