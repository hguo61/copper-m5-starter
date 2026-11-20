// Module 5: the golden-set experiment. Asks Ask Copper every question in the
// golden set (the Langfuse dataset, lib/copper/golden-set.ts), then an AI
// judge compares each reply with the expected answer and gives it a score
// from 0 to 1. Langfuse keeps each run, so two runs can be compared side by
// side (npm run golden:run).
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { AGENT_NAMES, type Progress } from "@/lib/copper/assistant/progress";
import { DEFAULT_LIMIT_USD } from "@/lib/copper/orders";

/** The score's name in Langfuse. */
export const GOLDEN_SCORE = "golden-set-judge";

/** What the experiment keeps of one answer: the reply and how it was made. */
export type GoldenAnswer = {
  reply: string;
  /** Who wrote the reply. */
  agent: string;
  status: Progress["status"];
  /** Each tool call and handoff, in order. */
  steps: (
    | { tool: string; by: string; input: unknown; output: unknown }
    | { handoff: string }
  )[];
};

/**
 * Asks Ask Copper one golden question, as a new conversation. On the Support
 * page the Refund Console starts fresh: the default limit and no refunds yet.
 */
export async function answerGoldenQuestion(input: {
  question: string;
  page: "home" | "support";
}): Promise<GoldenAnswer> {
  const { progress } = await askCopper({
    messages: [{ role: "user", content: input.question }],
    useTools: true,
    desk:
      input.page === "support"
        ? { limitUsd: DEFAULT_LIMIT_USD, refunds: [] }
        : undefined,
  });
  const final = await finalValue(progress);
  const steps: GoldenAnswer["steps"] = [];
  for (const step of final.steps) {
    if (step.type === "tool")
      steps.push({
        tool: step.name,
        by: AGENT_NAMES[step.agent ?? "copper"],
        input: step.input,
        output: step.output,
      });
    if (step.type === "handoff")
      steps.push({
        handoff: `${AGENT_NAMES[step.from]} → ${AGENT_NAMES[step.to]}`,
      });
  }
  return {
    reply: final.reply,
    agent: AGENT_NAMES[final.agent ?? "copper"],
    status: final.status,
    steps,
  };
}

/** Long tool results (document passages) are cut so the judge's prompt stays short. */
const MAX_TOOL_OUTPUT = 1500;

/** The answer as the judge reads it: what was done, then the reply. */
export function describeAnswer(answer: GoldenAnswer): string {
  const steps = answer.steps.map((step) =>
    "handoff" in step
      ? `- Handoff: ${step.handoff}`
      : `- ${step.by} called ${step.tool}(${JSON.stringify(step.input ?? {})}) and got: ${JSON.stringify(
          step.output ?? null,
        ).slice(0, MAX_TOOL_OUTPUT)}`,
  );
  return [
    "What the assistant did:",
    steps.length ? steps.join("\n") : "- No tool calls and no handoff.",
    "",
    `Reply, written by ${answer.agent}:`,
    answer.reply,
  ].join("\n");
}

export function judgePrompt(
  question: string,
  expected: string,
  answer: GoldenAnswer,
): string {
  return `You are grading a customer support assistant for Copper State Labs against a test case.

Customer's message:
<message>
${question}
</message>

What a good answer says and does:
<expected>
${expected}
</expected>

What the assistant actually did and said:
<actual>
${describeAnswer(answer)}
</actual>

Grade only against the expected answer. Check each thing it requires: the facts and amounts in the reply, the tools that had to be called, whether there had to be a handoff, and anything it says must NOT happen. Different wording is fine. Extra helpful detail is fine unless it contradicts the expected answer.

Score from 0 to 1:
- 1: meets every requirement.
- 0.75: the facts and the outcome are right, with one small miss (for example a missing citation).
- 0.5: partly right: a required fact, tool call or handoff is missing.
- 0.25: mostly wrong.
- 0: wrong, or it did something the expected answer forbids.`;
}

const verdict = z.object({
  reasoning: z
    .string()
    .describe("One or two sentences: what matched and what cost points."),
  score: z.number().min(0).max(1),
});

/** The judge: compares one answer with what was expected. */
export async function judgeGoldenAnswer(params: {
  question: string;
  expected: string;
  answer: GoldenAnswer;
}) {
  const result = await callObject(
    { module: 5, feature: GOLDEN_SCORE },
    {
      schema: verdict,
      prompt: judgePrompt(params.question, params.expected, params.answer),
    },
  );
  return {
    name: GOLDEN_SCORE,
    value: result.output.score,
    comment: result.output.reasoning,
  };
}

/** The part of a Langfuse dataset the experiment uses. */
export type GoldenDataset = {
  runExperiment(params: {
    name: string;
    description?: string;
    metadata?: Record<string, string>;
    maxConcurrency?: number;
    task: (item: { input?: unknown }) => Promise<unknown>;
    evaluators: ((params: {
      input: unknown;
      output: unknown;
      expectedOutput?: unknown;
    }) => Promise<{ name: string; value: number; comment?: string }>)[];
    runEvaluators: ((params: {
      itemResults: { evaluations: { name: string; value: unknown }[] }[];
    }) => Promise<{ name: string; value: number; comment?: string }>)[];
  }): Promise<GoldenRun>;
};

export type GoldenRun = {
  runName: string;
  datasetRunUrl?: string;
  itemResults: {
    /** The dataset item that was asked. */
    item?: { input?: unknown };
    output?: unknown;
    evaluations: { name: string; value: unknown; comment?: string | null }[];
  }[];
};

export type GoldenResult = {
  runName: string;
  url?: string;
  average: number;
  rows: { question: string; score: number | null; reason: string }[];
};

const scoreOf = (item: GoldenRun["itemResults"][number]) => {
  const value = item.evaluations.find((e) => e.name === GOLDEN_SCORE)?.value;
  return typeof value === "number" ? value : null;
};

const average = (scores: (number | null)[]) => {
  const numbers = scores.filter((s): s is number => s !== null);
  return numbers.length
    ? numbers.reduce((sum, s) => sum + s, 0) / numbers.length
    : 0;
};

/**
 * Runs the golden set as one experiment in Langfuse. Questions are asked one
 * at a time, to stay inside a free Google AI key's rate limit.
 */
export async function runGoldenExperiment(
  dataset: GoldenDataset,
  options: { label?: string } = {},
): Promise<GoldenResult> {
  const run = await dataset.runExperiment({
    name: options.label ?? "ask-copper",
    description:
      "Ask Copper on the golden set: each reply is graded against the expected answer.",
    metadata: { agents: "copper + refund agent" },
    maxConcurrency: 1,
    task: (item) =>
      answerGoldenQuestion(
        item.input as { question: string; page: "home" | "support" },
      ),
    evaluators: [
      ({ input, output, expectedOutput }) =>
        judgeGoldenAnswer({
          question: (input as { question: string }).question,
          expected: String(expectedOutput),
          answer: output as GoldenAnswer,
        }),
    ],
    runEvaluators: [
      async ({ itemResults }) => ({
        name: `${GOLDEN_SCORE}-average`,
        value: average(itemResults.map(scoreOf)),
        comment: `Average over ${itemResults.length} questions.`,
      }),
    ],
  });
  return {
    runName: run.runName,
    url: run.datasetRunUrl,
    average: average(run.itemResults.map(scoreOf)),
    rows: run.itemResults.map((item) => ({
      question: (item.item?.input as { question?: string })?.question ?? "",
      score: scoreOf(item),
      reason:
        item.evaluations.find((e) => e.name === GOLDEN_SCORE)?.comment ?? "",
    })),
  };
}
