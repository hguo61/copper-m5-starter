# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4: Refund agent, handoff and approvals

**Summary:** On the Support page, Copper hands refund requests to a second
agent, the Refund agent, with its own instructions and tools. The app (code,
not the model) compares the order amount with an auto-refund limit you can
change: at or under it, the refund goes through; over it, the refund waits on
the Refund Console until a person clicks Approve or Reject, and the Refund
agent tells the customer.

| Piece | Where | What it does |
|---|---|---|
| Orders and the rule | `lib/copper/orders.ts`, `lib/copper/data/orders.json` | Maya Reyes's four orders (#1001 to #1004). `requestRefund()` decides: `refunded` at or under the limit, `needs_approval` over it; an order already decided keeps its status; `not_found` for unknown numbers |
| Handoffs | `lib/copper/assistant/tools.ts`, `ask.ts` | Copper's `transfer_to_refund_agent` (Support page only) and the Refund agent's `transfer_to_copper`. Each ends that agent's turn (`hasToolCall`); the other agent answers the same conversation. The agent that ends a turn answers the next message |
| Refund agent | `lib/copper/assistant/instructions.ts` (`REFUND_AGENT_INSTRUCTIONS`), `tools.ts` (`refundAgentTools`) | `get_orders` and `request_refund`, built on the desk the chat sends. Copper can't use these |
| Refund Console | `app/support/page.tsx`, `components/copper/refund-console.tsx` | The auto-refund limit ($50 to start), the refunds waiting for approval with Approve and Reject, and the orders with their status. State lives in the page: a reload starts fresh |
| Chat panel | `components/copper/ask-copper.tsx` | With `support`, sends the desk (limit and refunds so far) and the current agent with each message, puts each `request_refund` decision on the console, and sends the console's "[Refund Console] A supervisor approved …" note to the Refund agent, which tells the customer. Shows each handoff as its own station |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One call per agent in a turn |

**Data flow:** question → Copper → `transfer_to_refund_agent` → Refund agent
→ `request_refund` → the app compares the amount with the limit → refunded,
or waiting on the Refund Console → Approve or Reject → console note → Refund
agent tells the customer.

**Decisions and trade-offs:** The refund decision is code, so the model can't
argue past the limit. Two agents keep refund tools away from Copper. A real
handoff (the other agent answers) rather than an agent called as a tool keeps
one voice per reply. The console's state lives in the browser and goes with
each message, so there's nothing to set up and nothing stored on the server;
the cost is that a reload forgets every refund.

**Risks and open questions:** A customer can claim a supervisor already
approved; the Refund agent must still ask the app. Setting the limit to 0
sends every refund to a person. A real app needs a database so refunds
survive a reload and several supervisors see the same queue.

## Module 5 starter

**Summary:** Module 4 as finished. Module 5 makes Ask Copper safe to ship:
the tests and a golden-set evaluation with an AI judge run in GitHub Actions
on every pull request, with `main` protected; every AI call is traced in
Langfuse; and one support agent that does everything is compared with the two
agents on the same golden set. Langfuse is the only eval and monitoring tool.

## Module 5: Langfuse tracing (observability)

**Summary:** With the Langfuse keys set, every AI call is traced in Langfuse:
which agent ran, each step, each tool call, the tokens, the cost and how long
it took. One question to Ask Copper is one trace. Without the keys nothing is
traced and the app works as before.

**New pages:** none. The traces are in Langfuse, under Tracing.

**New code:**

- `instrumentation.ts`: Next.js runs it once when the server starts; it starts
  tracing.
- `lib/ai/tracing.ts`: `startTracing` (sets up Langfuse), `traced` (groups the
  calls of one turn into one trace), `flushTracing` (sends what's waiting) and
  `CostProcessor` (adds the cost to each model call).
- `lib/ai/call.ts`: names each call after its feature (`ask-copper`,
  `refund-agent`) and adds the module and feature to the trace.
- `lib/copper/assistant/ask.ts`: wraps a turn in `traced`, with the question
  as the input and the reply as the output.

**New AI calls:** none.

**What a trace looks like:** `ask-copper` (home page) or `support-chat`
(Support page) → one agent per `callStream` (`ask-copper`, then
`refund-agent` after a handoff) → its steps → the model call (tokens, cost,
time) and the tool calls (what was sent, what came back). Traces are tagged
`tools-on` or `tools-off`.

**Data flow:** the AI SDK reports each call, step and tool call →
`@langfuse/vercel-ai-sdk` turns them into spans → `CostProcessor` adds the
cost → `LangfuseSpanProcessor` sends them to Langfuse.

**Decisions and trade-offs:** Cost comes from this app's price table
(`lib/ai/pricing.ts`), so Langfuse and the `[ai_calls]` log always agree, even
for a model Langfuse has no price for; the cost of a new model has to be added
there. Only the model call is priced, not the step or agent around it, so
nothing is counted twice. The tracing setup is kept apart from Next.js's own
request spans, so Langfuse holds AI calls only. Questions, replies and tool
results are sent to Langfuse as they are.

**Risks and open questions:** Anything a customer types ends up in Langfuse;
a real app would mask personal data first. There is no session id yet, so the
messages of one conversation are separate traces.

## Module 5: AI judge (Langfuse LLM-as-a-judge)

**Summary:** Langfuse's own LLM-as-a-judge reads every Ask Copper reply as it
is traced and gives it a score from 0 to 1 with a one-line reason. The judge
runs inside Langfuse, not in this app; the app only describes it and sets it
up once with `npm run judge:setup`.

**New pages:** none. The scores are in Langfuse, on each trace and under
Scores. `npm run judge:scores` prints the latest ones.

**New code:**

- `lib/copper/judge.ts`: the judge's instructions (`JUDGE_PROMPT`), its score
  (`JUDGE_SCORE`), which traces it reads (`JUDGE_FILTER`) and `setupJudge`,
  which creates what's missing in Langfuse.
- `scripts/judge.mjs`: the `judge:setup` and `judge:scores` commands.

**What is set up in Langfuse:** an LLM connection (a Google AI key, so
Langfuse can call Gemini), an evaluator named `ask-copper-answer-quality`, and
an evaluation rule that runs it on the top record of every `ask-copper` and
`support-chat` trace.

**New AI calls:** one judge call per Ask Copper turn, made by Langfuse with
the key stored there (`gemini-3.5-flash-lite`). They don't go through
`lib/ai/call.ts` and don't appear in the `[ai_calls]` log.

**Data flow:** a turn is traced → Langfuse matches it to the rule → fills
`{{question}}` with the trace's input and `{{answer}}` with its reply → asks
Gemini → saves the score and the reason on the trace.

**Decisions and trade-offs:** Langfuse runs the judge, so every reply is
scored with no code in the request path and nothing slows the chat; the cost
is that Langfuse holds a copy of the Google AI key and the judge's calls use
that key's quota. The judge sees only the question and the reply, not the
documents or tool results, so it scores how well the reply answers, not
whether its facts are right.

**Risks and open questions:** Checking facts needs a golden set with expected
answers. A judge is a model too: read its reasons before trusting a score.

## Module 5: Golden set (Langfuse dataset)

**Summary:** A fixed list of test questions for Ask Copper, each with what a
good answer looks like. It lives in `evals/golden-set.json` and is kept in
Langfuse as the dataset `ask-copper-golden` (`npm run golden:upload`).

**New code:** `evals/golden-set.json` (the questions),
`lib/copper/golden-set.ts` (`uploadGoldenSet`), and the `golden` command in
`scripts/judge.mjs`.

**What a question holds:** the customer's message, the page it's asked on
(home or Support), a category (pricing, products, stock, policy,
troubleshooting, refund, safety) and the expected answer in plain English.

**Decisions and trade-offs:** The file in the repo is the source; Langfuse
holds a copy, so a change to the questions goes through a pull request.
Expected answers describe what the reply must say and do rather than exact
wording, so a judge can compare them with a real reply. They repeat facts
from the catalog, the orders and the documents, so they must be updated when
those change.

**Risks and open questions:** The expected answers are only as good as the
person who wrote them; review them like code.

## Module 5: Golden-set experiment and its judge

**Summary:** `npm run golden:run` asks Ask Copper every question in the
golden set, then an AI judge compares each reply with the expected answer and
scores it from 0 to 1 with a reason. Each run is kept in Langfuse under
Datasets > `ask-copper-golden`, so two runs can be compared side by side.

**New code:**

- `lib/copper/experiment.ts`: `answerGoldenQuestion` (asks through the real
  `askCopper`, as a new conversation), `judgeGoldenAnswer` (the judge) and
  `runGoldenExperiment` (runs the whole set with Langfuse's experiment
  runner).
- `scripts/golden-run.mjs`: the `golden:run` command. `--label` names the
  run; `--min-average 0.8` makes it fail when the average is lower.

**New AI calls:** `golden-set-judge` (module 5), one per question, through
`callObject` in `lib/ai/call.ts`.

**Scores in Langfuse:** `golden-set-judge` on each question's trace, with the
judge's reason, and `golden-set-judge-average` on the run.

**Data flow:** dataset item → `askCopper` (traced like any chat turn: agents,
steps, tool calls, cost, time) → the reply, tool calls and handoffs → the
judge, with the expected answer → score and reason → Langfuse.

**Two judges, two jobs:** this judge runs in the app and knows the expected
answer and which tools ran, so it can check facts and behavior on the test
questions. The Langfuse judge (`lib/copper/judge.ts`) runs inside Langfuse on
real conversations, where there is no expected answer.

**Decisions and trade-offs:** The judge sees the tool calls and handoffs, not
only the reply, so "uses calculate_cost" and "must not refund" can be
checked. Questions run one at a time to stay inside a free key's rate limit,
so a run takes a minute or two. Support-page questions start from a fresh
Refund Console with the default limit.

**Risks and open questions:** The judge and Ask Copper are the same model, so
they may share blind spots. Scores can differ a little from run to run. The
experiment isn't run in GitHub Actions yet.
