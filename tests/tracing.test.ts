// @vitest-environment node
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callText } from "@/lib/ai/call";
import { costUsd } from "@/lib/ai/pricing";
import {
  costDetailsFor,
  flushTracing,
  isTracingConfigured,
  startTracing,
  traced,
} from "@/lib/ai/tracing";

// Google hands back whatever mock model the test sets.
let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** First asks for the get_prices tool, then answers. */
function toolThenAnswer() {
  let calls = 0;
  return new MockLanguageModelV4({
    provider: "google.generative-ai",
    modelId: "gemini-3.5-flash-lite",
    doGenerate: async () =>
      calls++ === 0
        ? {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "get_prices",
                input: "{}",
              },
            ],
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: usage(1000, 200),
            warnings: [],
          }
        : {
            content: [{ type: "text" as const, text: "Copper Home is $149." }],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: usage(1500, 100),
            warnings: [],
          },
  });
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("cost of a model call", () => {
  const chat = {
    "gen_ai.operation.name": "chat",
    "gen_ai.response.model": "gemini-3.5-flash-lite",
    "gen_ai.usage.input_tokens": 1000,
    "gen_ai.usage.output_tokens": 200,
  };

  it("prices a model call from its tokens, like the ai_calls log", () => {
    // 1,000 x $0.3/M + 200 x $2.5/M = $0.0008
    expect(costDetailsFor(chat)).toEqual({
      input: 0.0003,
      output: 0.0005,
      total: costUsd("google/gemini-3.5-flash-lite", 1000, 200),
    });
  });

  it("knows a model by the name Google uses for it", () => {
    expect(
      costDetailsFor({
        ...chat,
        "gen_ai.response.model": "gemini-3-flash-preview",
      })?.total,
    ).toBeCloseTo(costUsd("google/gemini-3-flash", 1000, 200), 12);
  });

  it("doesn't price the agent or step around the call, or an unknown model", () => {
    expect(
      costDetailsFor({ ...chat, "gen_ai.operation.name": "invoke_agent" }),
    ).toBeUndefined();
    expect(
      costDetailsFor({ ...chat, "gen_ai.response.model": "some-other-model" }),
    ).toBeUndefined();
  });
});

describe("Langfuse tracing", () => {
  it("stays off, and the app still works, without the Langfuse keys", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    expect(isTracingConfigured()).toBe(false);
    expect(startTracing()).toBe(false);

    model = toolThenAnswer();
    const answer = await traced({ name: "ask-copper" }, async () => "fine");
    expect(answer).toBe("fine");
    await flushTracing();
  });

  it("sends one trace per question: the agent, each step, the tool call, tokens, cost and time", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    const exporter = new InMemorySpanExporter();
    expect(isTracingConfigured()).toBe(true);
    expect(startTracing(exporter)).toBe(true);
    // Starting twice keeps the first setup.
    expect(startTracing()).toBe(true);

    model = toolThenAnswer();
    const reply = await traced(
      {
        name: "ask-copper",
        input: "How much is Copper Home?",
        tags: ["tools-on"],
      },
      async (setOutput) => {
        const result = await callText(
          { module: 2, feature: "ask-copper" },
          {
            prompt: "How much is Copper Home?",
            tools: {
              get_prices: tool({
                inputSchema: z.object({}),
                execute: async () => ({ "Copper Home": 149 }),
              }),
            },
            stopWhen: stepCountIs(3),
          },
        );
        setOutput(result.text);
        return result.text;
      },
    );
    expect(reply).toBe("Copper Home is $149.");
    await flushTracing();

    const spans = exporter.getFinishedSpans();
    const named = (start: string) =>
      spans.filter((span) => span.name.startsWith(start));

    // One trace holds everything.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);

    // The turn, with the question and the answer.
    const [turn] = named("ask-copper");
    expect(turn.parentSpanContext).toBeUndefined();
    expect(turn.attributes["langfuse.observation.input"]).toContain(
      "How much is Copper Home?",
    );
    expect(turn.attributes["langfuse.observation.output"]).toContain("$149");
    expect(turn.attributes["langfuse.trace.name"]).toBe("ask-copper");
    expect(turn.attributes["langfuse.trace.tags"]).toEqual(["tools-on"]);

    // The agent, named after the feature, inside the turn.
    const [agent] = named("invoke_agent");
    expect(agent.attributes["gen_ai.agent.name"]).toBe("ask-copper");
    expect(agent.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(agent.attributes["langfuse.observation.metadata.module"]).toBe("2");

    // Two steps: the tool call, then the answer.
    expect(named("step")).toHaveLength(2);
    const [toolCall] = named("execute_tool");
    expect(toolCall.attributes["gen_ai.tool.name"]).toBe("get_prices");
    expect(toolCall.attributes["gen_ai.tool.call.result"]).toContain("149");

    // Each model call has its tokens and its cost; the costs add up to what
    // the ai_calls log reports for the whole call.
    const chats = named("chat");
    expect(chats).toHaveLength(2);
    expect(chats[0].attributes["gen_ai.usage.input_tokens"]).toBe(1000);
    expect(chats[0].attributes["gen_ai.usage.output_tokens"]).toBe(200);
    const total = chats
      .map(
        (span) =>
          JSON.parse(
            span.attributes["langfuse.observation.cost_details"] as string,
          ).total as number,
      )
      .reduce((sum, cost) => sum + cost, 0);
    expect(total).toBeCloseTo(
      costUsd("google/gemini-3.5-flash-lite", 2500, 300),
      12,
    );
    // Only model calls carry a cost, so nothing is counted twice.
    expect(
      spans.filter((s) => "langfuse.observation.cost_details" in s.attributes),
    ).toHaveLength(2);

    // Every span is timed: that's the latency Langfuse shows.
    for (const span of spans) {
      expect(span.endTime[0] * 1e9 + span.endTime[1]).toBeGreaterThanOrEqual(
        span.startTime[0] * 1e9 + span.startTime[1],
      );
    }
  });
});
