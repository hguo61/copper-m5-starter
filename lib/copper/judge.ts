// Module 5: the AI judge. Langfuse's own "LLM-as-a-judge" reads each Ask
// Copper answer as it's traced and gives it a score from 0 to 1 with a reason.
// The judge runs inside Langfuse, not in this app: this file only describes
// the judge and sets it up in your Langfuse project (npm run judge:setup).
//
// Three things are set up in Langfuse:
// - an LLM connection: your Google AI key, so Langfuse can call Gemini;
// - an evaluator: the judge's instructions and the score it gives;
// - an evaluation rule: which traces the judge reads (every Ask Copper turn).

/** The judge's name in Langfuse; its scores carry this name too. */
export const JUDGE_NAME = "ask-copper-answer-quality";

/** The traces the judge reads: one per question (lib/copper/assistant/ask.ts). */
export const JUDGED_TRACES = ["ask-copper", "support-chat"];

/** The Gemini model the judge uses, by Google's name for it. */
export const JUDGE_MODEL = "gemini-3.5-flash-lite";

/** What Langfuse calls the Google AI Studio connection made by the setup. */
export const JUDGE_PROVIDER = "google";

export const JUDGE_PROMPT = `You are reviewing a reply from Copper, the customer support assistant of Copper State Labs, a company that sells two smart devices (Copper Home and Copper Notes) and a subscription (Copper Plus).

Customer's message:
<message>
{{question}}
</message>

Copper's reply:
<reply>
{{answer}}
</reply>

Judge the reply on these points:
1. It answers what the customer asked, or does what they asked for (for example, a refund).
2. It stays on Copper State Labs' products, plans, policies and orders, and politely declines anything else.
3. It is specific: prices, dates, order numbers and policy details rather than vague statements. Claims about documents point to the document.
4. It is clear, polite and short enough to read easily.
5. It doesn't promise something a support assistant can't deliver, and doesn't just apologize and give up when the question could be answered.

You can't check the facts yourself, so don't mark a reply down for a fact you can't verify. Mark it down if it contradicts itself or the customer's message.`;

/** The score: a number from 0 to 1, with the judge's reason. */
export const JUDGE_SCORE = {
  dataType: "NUMERIC",
  minValue: 0,
  maxValue: 1,
  scoreValueInstructions:
    "A number from 0 to 1. 1: fully answers the customer, on topic, specific and clear. 0.75: a good answer with a small gap. 0.5: partly answers, or is vague. 0.25: mostly unhelpful. 0: doesn't answer, is off topic, or is only an error message.",
  scoreReasoningInstructions:
    "In one or two sentences, say what the reply did well and what cost it points.",
} as const;

/**
 * Where the judge's {{question}} and {{answer}} come from: the trace's input
 * (the customer's message) and the "reply" field of its output.
 */
export const JUDGE_VARIABLES = [
  { variable: "question", source: "input" },
  { variable: "answer", source: "output", jsonPath: "$.reply" },
] as const;

/** Which traced records the judge reads: the top record of each chat turn. */
export const JUDGE_FILTER = [
  {
    type: "stringOptions",
    column: "name",
    operator: "any of",
    value: JUDGED_TRACES,
  },
  { type: "boolean", column: "isRootObservation", operator: "=", value: true },
] as const;

/** Calls the Langfuse API: `request("GET", "/api/public/v2/evaluators")`. */
export type LangfuseRequest = (
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export type JudgeSetupResult =
  | { status: "needs-connection" }
  | {
      status: "ready";
      evaluatorId: string;
      ruleId: string;
      /** What this run made; anything else was already there. */
      created: ("connection" | "evaluator" | "rule")[];
    };

type Named = { id: string; name: string };
const list = (response: unknown) =>
  ((response as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[];

/**
 * Sets up the judge in Langfuse. Safe to run again: it only makes what's
 * missing. Langfuse needs a Google AI key to run the judge; pass `googleKey`
 * to store yours there, otherwise this stops and says a connection is needed.
 */
export async function setupJudge(
  request: LangfuseRequest,
  options: { googleKey?: string } = {},
): Promise<JudgeSetupResult> {
  const created: ("connection" | "evaluator" | "rule")[] = [];

  const connections = list(await request("GET", "/api/public/llm-connections"));
  const connection = connections.find((c) => c.adapter === "google-ai-studio");
  if (!connection) {
    if (!options.googleKey) return { status: "needs-connection" };
    await request("PUT", "/api/public/llm-connections", {
      provider: JUDGE_PROVIDER,
      adapter: "google-ai-studio",
      secretKey: options.googleKey,
      withDefaultModels: true,
      customModels: [JUDGE_MODEL],
    });
    created.push("connection");
  }
  const provider = String(connection?.provider ?? JUDGE_PROVIDER);

  const evaluators = list(await request("GET", "/api/public/v2/evaluators"));
  let evaluator = evaluators.find((e) => e.name === JUDGE_NAME) as
    Named | undefined;
  if (!evaluator) {
    evaluator = (await request("POST", "/api/public/v2/evaluators", {
      name: JUDGE_NAME,
      description:
        "Scores each Ask Copper reply from 0 to 1: does it answer the customer, on topic, specific and clear?",
      type: "llm_as_judge",
      prompt: JUDGE_PROMPT,
      modelConfig: { provider, model: JUDGE_MODEL },
      variableMapping: JUDGE_VARIABLES,
      outputDefinition: JUDGE_SCORE,
    })) as Named;
    created.push("evaluator");
  }

  const rules = list(await request("GET", "/api/public/v2/evaluation-rules"));
  let rule = rules.find((r) => r.name === JUDGE_NAME) as Named | undefined;
  if (!rule) {
    rule = (await request("POST", "/api/public/v2/evaluation-rules", {
      name: JUDGE_NAME,
      enabled: true,
      // Judge every reply. Lower this (0.1 = one in ten) to spend less.
      sampling: 1,
      filter: JUDGE_FILTER,
      evaluatorAssignments: [
        { evaluatorId: evaluator.id, variableMapping: JUDGE_VARIABLES },
      ],
    })) as Named;
    created.push("rule");
  }

  return {
    status: "ready",
    evaluatorId: evaluator.id,
    ruleId: rule.id,
    created,
  };
}

export type JudgeScore = {
  value: number;
  comment: string | null;
  timestamp: string;
  traceId: string | null;
};

/** The judge's latest scores, newest first. */
export async function latestJudgeScores(
  request: LangfuseRequest,
  limit = 10,
): Promise<JudgeScore[]> {
  const query = new URLSearchParams({
    name: JUDGE_NAME,
    limit: String(limit),
    fields: "details,subject",
  });
  const scores = list(await request("GET", `/api/public/v3/scores?${query}`));
  return scores.map((score) => ({
    value: Number(score.value),
    comment: typeof score.comment === "string" ? score.comment : null,
    timestamp: String(score.timestamp),
    traceId:
      ((score.subject as Record<string, unknown> | undefined)?.traceId as
        string | undefined) ?? null,
  }));
}
