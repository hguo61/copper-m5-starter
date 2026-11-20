// @vitest-environment node
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLive } from "@/lib/ai/live";
import type {
  AskCopperRequest,
  AskCopperResult,
} from "@/lib/copper/assistant/ask";
import type { Progress } from "@/lib/copper/assistant/progress";
import {
  answerGoldenQuestion,
  describeAnswer,
  GOLDEN_SCORE,
  judgeGoldenAnswer,
  judgePrompt,
  runGoldenExperiment,
  type GoldenAnswer,
  type GoldenDataset,
} from "@/lib/copper/experiment";
import { GOLDEN_SET } from "@/lib/copper/golden-set";

// Ask Copper is replaced by a canned refund conversation, so no model runs.
const asked: AskCopperRequest[] = [];
const refundTurn: Progress = {
  status: "done",
  agent: "refund",
  reply: "Your $7.99 is refunded to your original payment method.",
  steps: [
    { type: "thinking", text: "They want a refund.", agent: "copper" },
    {
      type: "tool",
      id: "0:a",
      agent: "copper",
      name: "transfer_to_refund_agent",
      state: "done",
      input: { reason: "refund" },
      output: { handedTo: "Refund agent" },
    },
    { type: "handoff", from: "copper", to: "refund" },
    {
      type: "tool",
      id: "1:b",
      agent: "refund",
      name: "request_refund",
      state: "done",
      input: { orderId: "1001" },
      output: { status: "refunded", amountUsd: 7.99 },
    },
  ],
};
vi.mock("@/lib/copper/assistant/ask", () => ({
  askCopper: async (request: AskCopperRequest): Promise<AskCopperResult> => {
    asked.push(request);
    const { live, done } = createLive<Progress>();
    done(refundTurn);
    return { progress: live };
  },
}));

// Google hands back whatever mock model the test sets: here, the judge.
let model: MockLanguageModelV4;
let judgeSaw = "";
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));
function judgeSays(score: number, reasoning: string) {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      judgeSaw = JSON.stringify(prompt);
      return {
        content: [{ type: "text", text: JSON.stringify({ reasoning, score }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 500,
            noCache: 500,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 40, text: 40, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

const answer: GoldenAnswer = {
  reply: "Your $7.99 is refunded to your original payment method.",
  agent: "Refund agent",
  status: "done",
  steps: [
    {
      tool: "transfer_to_refund_agent",
      by: "Copper",
      input: { reason: "refund" },
      output: { handedTo: "Refund agent" },
    },
    { handoff: "Copper → Refund agent" },
    {
      tool: "request_refund",
      by: "Refund agent",
      input: { orderId: "1001" },
      output: { status: "refunded", amountUsd: 7.99 },
    },
  ],
};

beforeEach(() => {
  asked.length = 0;
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("asking a golden question", () => {
  it("asks on the Support page with a fresh Refund Console, and keeps the reply, the tool calls and the handoff", async () => {
    expect(
      await answerGoldenQuestion({
        question: "I'd like a refund for my Copper Plus monthly plan.",
        page: "support",
      }),
    ).toEqual(answer);
    expect(asked[0]).toEqual({
      messages: [
        {
          role: "user",
          content: "I'd like a refund for my Copper Plus monthly plan.",
        },
      ],
      useTools: true,
      desk: { limitUsd: 50, refunds: [] },
    });
  });

  it("asks on the home page without the Refund Console", async () => {
    await answerGoldenQuestion({ question: "What colors?", page: "home" });
    expect(asked[0].desk).toBeUndefined();
    expect(asked[0].useTools).toBe(true);
  });
});

describe("the golden-set judge", () => {
  it("is shown the question, the expected answer, the tool calls, the handoff and the reply", () => {
    const prompt = judgePrompt("Refund my plan.", "Refunds $7.99.", answer);
    expect(prompt).toContain("Refund my plan.");
    expect(prompt).toContain("Refunds $7.99.");
    expect(prompt).toContain(
      'Refund agent called request_refund({"orderId":"1001"})',
    );
    expect(prompt).toContain("Handoff: Copper → Refund agent");
    expect(prompt).toContain("Reply, written by Refund agent:");
    expect(prompt).toContain(answer.reply);
  });

  it("says so when the assistant used no tools", () => {
    expect(describeAnswer({ ...answer, steps: [] })).toContain(
      "No tool calls and no handoff.",
    );
  });

  it("returns a score from 0 to 1 with its reason, through lib/ai/call.ts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    model = judgeSays(0.75, "Right amount; no citation.");
    expect(
      await judgeGoldenAnswer({
        question: "Refund my plan.",
        expected: "Refunds $7.99.",
        answer,
      }),
    ).toEqual({
      name: GOLDEN_SCORE,
      value: 0.75,
      comment: "Right amount; no citation.",
    });
    expect(judgeSaw).toContain("Refunds $7.99.");
    const logged = info.mock.calls.find(([tag]) => tag === "[ai_calls]");
    expect(JSON.parse(logged![1] as string)).toMatchObject({
      module: 5,
      feature: GOLDEN_SCORE,
    });
  });
});

describe("npm run golden:run", () => {
  it("asks every question once, one at a time, has each reply judged and reports the average", async () => {
    const scores = [1, 0.5];
    let call = 0;
    model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reasoning: `reason ${call % 2}`,
              score: scores[call++ % 2],
            }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const items = GOLDEN_SET.slice(0, 2).map((q) => ({
      input: { question: q.question, page: q.page },
      expectedOutput: q.expected,
    }));
    let settings: Record<string, unknown> = {};
    let runAverage: unknown;
    // A stand-in for the Langfuse dataset: runs the task and the judge on
    // each item, as Langfuse's runner does.
    const dataset: GoldenDataset = {
      async runExperiment(params) {
        settings = params;
        const itemResults = [];
        for (const item of items) {
          const output = await params.task(item);
          const evaluations = [await params.evaluators[0]({ ...item, output })];
          itemResults.push({ item, output, evaluations });
        }
        runAverage = (await params.runEvaluators[0]({ itemResults })).value;
        return {
          runName: "ask-copper - test",
          datasetRunUrl: "https://langfuse.test/run",
          itemResults,
        };
      },
    };

    const result = await runGoldenExperiment(dataset);
    expect(settings).toMatchObject({ name: "ask-copper", maxConcurrency: 1 });
    expect(asked).toHaveLength(2);
    expect(result).toEqual({
      runName: "ask-copper - test",
      url: "https://langfuse.test/run",
      average: 0.75,
      rows: [
        { question: items[0].input.question, score: 1, reason: "reason 0" },
        { question: items[1].input.question, score: 0.5, reason: "reason 1" },
      ],
    });
    expect(runAverage).toBe(0.75);

    await runGoldenExperiment(dataset, { label: "single-agent" });
    expect(settings.name).toBe("single-agent");
  });
});
