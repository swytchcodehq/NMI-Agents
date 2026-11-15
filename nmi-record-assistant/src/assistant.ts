// NMI record assistant (terminal).
//
// Describe a record in plain English ("John Smith's refund last week", "order
// 1234567890", "invoice 88 for acme") and the model finds it in NMI and tells
// you its status.
//
// An OpenAI model (Responses API) turns the description into filters for ONE
// Swytchcode tool, nmi_payments.query.php.create (NMI Query API, POST
// /query.php). It is a read-only lookup: transactions by default, and
// customer-vault, subscription and invoice records through report_type. Every
// NMI call goes through Swytchcode (@swytchcode/runtime -> `swytchcode exec`).
//
// Keys:
//   OPENAI_API_KEY  -> .env in this folder
//   NMI security key -> `swytchcode auth connect nmi` (stored by Swytchcode, injected per call)
// No NMI credential is read or set in this file, and security_key is never sent.
// The NMI base URL is non-secret config: SWYTCHCODE_BASE_URL_NMI_NMI_SANDBOX
// (defaults to https://sandbox.nmi.com/api below).
//
// Run:  npm start                        interactive
//       npm start -- "order 1234567890"  one question, then exit

import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { Swytchcode, isSwytchcodeError } from "@swytchcode/runtime";
import { AnthropicProvider } from "@swytchcode/runtime/providers/anthropic";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { promisify } from "node:util";

// OPENAI_API_KEY, OPENAI_MODEL, ASSISTANT_EFFORT and the NMI base URL. Never NMI credentials.
if (existsSync(path.resolve(".env"))) process.loadEnvFile(".env");
process.env.SWYTCHCODE_BASE_URL_NMI_NMI_SANDBOX ??= "https://sandbox.nmi.com/api";

const TOOL_ID = "nmi_payments.query.php.create";
const TOOL_NAME = "nmi_query";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5";
const EFFORT = (process.env.ASSISTANT_EFFORT ?? "medium") as "minimal" | "low" | "medium" | "high";
const DEFAULT_RESULT_LIMIT = 25;
const MAX_TOOL_RESULT_CHARS = 60_000;
const MAX_LOOKUPS_PER_QUESTION = 8;
const MAX_MODEL_ROUNDS = 12;
const EXEC_TIMEOUT_MS = 120_000;

// Contract inputs that are not search filters: security_key is the credential
// (Swytchcode injects auth itself) and additionalProperties is a schema artifact.
const EXCLUDED_INPUTS = new Set(["security_key", "additionalProperties"]);

// Hints for fields whose contract entry has no format. Dates match the
// YYYYMMDDhhmmss values in the contract's example response.
const FIELD_HINTS: Record<string, string> = {
  start_date: "Range start, UTC, format YYYYMMDDhhmmss (e.g. 20261101000000).",
  end_date: "Range end, UTC, format YYYYMMDDhhmmss (e.g. 20261113235959).",
  date_search: "Which date start_date/end_date filter on. Use with start_date/end_date.",
  report_type:
    "Omit for transactions. customer_vault = stored customers, recurring = subscriptions, recurring_plans = plans, invoicing = invoices.",
  condition: "Overall transaction status filter.",
  cc_number: "Last 4 digits of the card ONLY (e.g. 1111). Never a full card number.",
  result_limit: `Max records to return. Default ${DEFAULT_RESULT_LIMIT}.`,
  page_number: "Page of results, 0-based. Requires result_limit.",
  result_order: "standard = oldest first, reverse = newest first.",
  invoice_status: "Invoice filter (with report_type=invoicing).",
};

const SYSTEM_PROMPT = `You are an NMI payment-gateway assistant. The user describes a record in plain language; you find it with the ${TOOL_NAME} tool and tell them its status.

The tool calls NMI's Query API. Records it can find:
- Transactions (default, no report_type): filter by transaction_id, order_id, first_name/last_name, email, phone, address fields, cc_number (last 4 only), action_type, condition, transaction_type, source, dates.
- Stored customers: report_type=customer_vault (customer_vault_id, name, email, ...).
- Subscriptions: report_type=recurring (subscription_id).
- Recurring plans: report_type=recurring_plans.
- Invoices: report_type=invoicing (invoice_id, invoice_status).

How to search:
- Use the most specific identifier the user gave (transaction_id, order_id, invoice_id, subscription_id, customer_vault_id). Otherwise combine what they said: name, email, last 4 card digits, action type, and a date range.
- Translate relative dates ("yesterday", "last week") to UTC start_date/end_date in YYYYMMDDhhmmss. The current time is given with each message.
- Always set result_limit (10 is a good default for name or date searches) and result_order=reverse so the newest come first.
- If nothing matches, widen the search once (drop the narrowest filter or extend the date range) and say what you changed. Don't do more than ${MAX_LOOKUPS_PER_QUESTION} lookups for one question.
- Results are XML. An <error_response> element means NMI rejected the query: explain it.

How to report status:
- Transactions: lead with <condition> (pending, pendingsettlement, in_progress, complete, failed, canceled, abandoned, unknown) in plain words, then the action history from the <action> elements in date order: action_type, amount, date, and whether it succeeded (<success>1</success>) with <response_text>. Note refunds, voids, or captures that changed the outcome.
- Invoices: invoice status. Subscriptions and customers: say what the record shows about its state.
- Start with a one-line answer, e.g. "Order 1234567890 is settled: $11.00 sale on 12 Mar 2015, then refunded $5.00 on 14 Mar."
- If several records match, show a short table (ID, name, amount, date, status) and ask which one they mean unless the description clearly picks one.
- Include the IDs you found. Never show full card numbers; use the last 4 digits only.
- This is a plain terminal: no Markdown headings; simple tables are fine.
- If the tool reports an auth error, tell the user to run \`swytchcode auth connect nmi\`. Don't guess at data you didn't retrieve.`;

// ---------- Tool definition from the Swytchcode contract ----------

const execFileAsync = promisify(execFile);

interface ContractInput {
  TYPE?: string;
  ENUM?: string[];
  REQUIRED?: boolean;
}

async function loadToolDefinition(): Promise<FunctionTool> {
  // `swytchcode` is an npm shim on Windows (.cmd), which needs a shell. Args are constants.
  // The CLI waits on an open stdin, so close it right away.
  const pending = execFileAsync("swytchcode", ["info", TOOL_ID, "--json"], {
    shell: process.platform === "win32",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    timeout: 60_000,
  });
  pending.child.stdin?.end();
  const { stdout } = await pending;
  const parsed = JSON.parse(stdout.trim());
  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  const inputs: Array<Record<string, ContractInput>> = info?.inputs ?? [];

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const entry of inputs) {
    for (const [name, spec] of Object.entries(entry)) {
      if (EXCLUDED_INPUTS.has(name)) continue;
      const prop: Record<string, unknown> = { type: spec.TYPE === "INT" ? "integer" : "string" };
      // cc_number's contract enum is the sandbox test-card list; the field accepts last-4 searches.
      if (spec.ENUM?.length && name !== "cc_number") prop.enum = spec.ENUM;
      if (FIELD_HINTS[name]) prop.description = FIELD_HINTS[name];
      properties[name] = prop;
      if (spec.REQUIRED) required.push(name);
    }
  }
  if (Object.keys(properties).length === 0) throw new Error(`No inputs found for ${TOOL_ID}; run \`swytchcode info ${TOOL_ID}\`.`);

  return {
    type: "function",
    name: TOOL_NAME,
    description:
      "Search NMI (Query API, read-only) for transactions, stored customers, subscriptions, plans, or invoices. " +
      "All filters are optional and combine with AND. Returns NMI's XML response.",
    parameters: { type: "object", properties, required, additionalProperties: false },
    // Strict mode would force every one of the ~36 optional filters to be sent; inputs are validated in checkInput instead.
    strict: false,
  };
}

// ---------- Swytchcode execution ----------

// The runtime needs a provider instance; it is only used here to resolve the
// tool's input routing (getInputs) and to execute, not to talk to any LLM.
const swx = new Swytchcode(new AnthropicProvider());
let rawInputs: unknown;

function describeError(e: unknown): { message: string; category?: string; retryable?: boolean } {
  const message = e instanceof Error ? e.message : String(e);
  if (isSwytchcodeError(e)) {
    // details is often unset when CLI log lines precede the JSON on stderr; fall back to the message.
    const category = e.details?.category ?? message.match(/"category"\s*:\s*"([\w-]+)"/)?.[1];
    const retryable = e.details?.retryable ?? (/"retryable"\s*:\s*true/.test(message) || undefined);
    const json = message.match(/\{"error":"((?:[^"\\]|\\.)*)"/)?.[1];
    return { message: json ?? message, category, retryable };
  }
  return { message };
}

function isTransient(e: unknown): boolean {
  const { message, category, retryable } = describeError(e);
  if (retryable || category === "network" || category === "rate_limit") return true;
  if (isSwytchcodeError(e) && e.cause === 4) return true;
  return /context canceled|failed to read response body|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(message);
}

async function queryNmi(input: Record<string, unknown>, dryRun = false): Promise<unknown> {
  // The Query API only reads, so retrying a transient failure is safe.
  for (let attempt = 0; ; attempt++) {
    try {
      return await swx.tools.execute(TOOL_ID, input, { _rawInputs: rawInputs, dryRun, timeoutMs: EXEC_TIMEOUT_MS });
    } catch (e) {
      if (attempt >= 3 || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
}

/** Validate the model's filters before anything leaves the machine. Returns an error message, or null. */
function checkInput(input: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) return `Unknown filter "${k}".`;
  }
  if (input.cc_number !== undefined && !/^\d{4}$/.test(String(input.cc_number))) {
    return "cc_number must be exactly the last 4 digits of the card.";
  }
  for (const k of ["start_date", "end_date"]) {
    if (input[k] !== undefined && !/^\d{14}$/.test(String(input[k]))) return `${k} must be YYYYMMDDhhmmss (14 digits, UTC).`;
  }
  return null;
}

/** Unwrap the exec envelope ({data, status_code, ...}) into text the model can read. */
function toResult(value: unknown): { text: string; failed: boolean } {
  const v = value as { data?: unknown; status_code?: number } | null;
  const body = v && typeof v === "object" && "data" in v ? v.data : value;
  let text = typeof body === "string" ? body : JSON.stringify(body);
  const status = v && typeof v === "object" ? v.status_code : undefined;
  const failed = (status ?? 0) >= 400 || /<error_response>/i.test(text);
  if (status !== undefined && status >= 400) text = `HTTP ${status}\n${text}`;
  if (!text.trim()) text = "(empty response: no matching records)";
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text =
      text.slice(0, MAX_TOOL_RESULT_CHARS) +
      `\n[Truncated: ${text.length} chars total. Narrow the filters or lower result_limit.]`;
  }
  return { text, failed };
}

// ---------- Agent loop ----------

let openai: OpenAI; // created in main() after the OPENAI_API_KEY check
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

async function runTool(call: ResponseFunctionToolCall, allowed: Set<string>): Promise<string> {
  if (call.name !== TOOL_NAME) return `Error: unknown tool ${call.name}`;
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(call.arguments || "{}");
  } catch {
    return "Error: arguments were not valid JSON. Call the tool again with a JSON object.";
  }
  const invalid = checkInput(input, allowed);
  if (invalid) return `Error: ${invalid}`;
  if (input.result_limit === undefined) input.result_limit = DEFAULT_RESULT_LIMIT;

  process.stdout.write(dim(`  ↳ searching NMI ${JSON.stringify(input)}\n`));
  try {
    const { text, failed } = toResult(await queryNmi(input));
    return failed ? `Error from NMI:\n${text}` : text;
  } catch (e) {
    const { message, category } = describeError(e);
    const hint = category === "auth" ? " Ask the user to run `swytchcode auth connect nmi`." : "";
    process.stdout.write(dim(`  ↳ failed (${category ?? "error"}): ${message}\n`));
    return `Swytchcode error (${category ?? "unknown"}): ${message}.${hint}`;
  }
}

async function ask(
  history: ResponseInputItem[],
  question: string,
  tool: FunctionTool,
  allowed: Set<string>,
): Promise<void> {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  const start = history.length;
  history.push({ role: "user", content: `${question}\n\n(Now: ${now} UTC)` });
  let lookups = 0;

  try {
    for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
      const response = await openai.responses.create({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: history,
        tools: [tool],
        reasoning: { effort: EFFORT },
        // Payment data stays out of OpenAI's stored responses; reasoning is carried forward encrypted.
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      // Carry every output item (reasoning, tool calls, messages) into the next request.
      history.push(...(response.output as ResponseInputItem[]));

      const calls = response.output.filter((i): i is ResponseFunctionToolCall => i.type === "function_call");
      if (calls.length === 0) {
        if (response.status === "incomplete") {
          console.log(`[Response incomplete: ${response.incomplete_details?.reason ?? "unknown reason"}]`);
        }
        console.log(response.output_text || "(no answer)");
        return;
      }
      for (const call of calls) {
        const output =
          ++lookups > MAX_LOOKUPS_PER_QUESTION
            ? "Lookup limit reached for this question. Answer with what you have."
            : await runTool(call, allowed);
        history.push({ type: "function_call_output", call_id: call.call_id, output });
      }
    }
    console.log("[Stopped: too many steps for one question. Try a more specific description.]");
  } catch (e) {
    // Roll back this question so the conversation stays valid for the next one.
    history.length = start;
    if (e instanceof OpenAI.AuthenticationError) console.error("OpenAI API key missing or invalid (set OPENAI_API_KEY in .env).");
    else if (e instanceof OpenAI.RateLimitError) console.error("OpenAI rate limit or quota reached. Wait a moment and try again.");
    else if (e instanceof OpenAI.NotFoundError) console.error(`OpenAI model "${MODEL}" not available to this key. Set OPENAI_MODEL in .env.`);
    else if (e instanceof OpenAI.APIError) console.error(`OpenAI API error ${e.status ?? ""}: ${e.message}`);
    else console.error(e instanceof Error ? e.message : String(e));
  }
}

// ---------- Startup ----------

async function preflight(): Promise<string | null> {
  // Dry run (no live command, nothing sent to NMI) to catch missing credentials or base URL early.
  try {
    await queryNmi({ transaction_id: "0", result_limit: 1 }, true);
    return null;
  } catch (e) {
    const { message, category } = describeError(e);
    if (category === "auth") return "NMI is not connected. Run: swytchcode auth connect nmi";
    if (/base url|base_url|localhost/i.test(message)) return "NMI base URL is not set. Set SWYTCHCODE_BASE_URL_NMI_NMI_SANDBOX in .env.";
    return `Swytchcode dry-run check failed (${category ?? "unknown"}): ${message}. Run \`swytchcode doctor\`.`;
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
    process.exit(1);
  }
  openai = new OpenAI(); // reads OPENAI_API_KEY
  // Fails if the method is not enabled in tooling.json.
  await swx.tools.get({ tools: [TOOL_ID] });
  rawInputs = swx.tools.getInputs(TOOL_ID);
  const tool = await loadToolDefinition();
  const allowed = new Set(Object.keys((tool.parameters?.properties as object) ?? {}));

  const warning = await preflight();
  if (warning) console.warn(`Warning: ${warning}\n`);

  const history: ResponseInputItem[] = [];
  const oneShot = process.argv.slice(2).join(" ").trim();
  if (oneShot) return ask(history, oneShot, tool, allowed);

  console.log(`NMI assistant (${MODEL}). Describe a record, e.g. "John Smith's refund last week". /new resets, "exit" quits.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => rl.close());
  try {
    while (true) {
      const q = (await rl.question("> ")).trim();
      if (!q) continue;
      if (/^(exit|quit)$/i.test(q)) break;
      if (q === "/new") {
        history.length = 0;
        console.log("(new conversation)\n");
        continue;
      }
      await ask(history, q, tool, allowed);
      console.log();
    }
  } catch {
    // readline closed (Ctrl+C / EOF)
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
