// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  JUDGE_FILTER,
  JUDGE_MODEL,
  JUDGE_NAME,
  JUDGE_PROMPT,
  JUDGE_SCORE,
  JUDGE_VARIABLES,
  JUDGED_TRACES,
  latestJudgeScores,
  setupJudge,
  type LangfuseRequest,
} from "@/lib/copper/judge";

// Deliberately not shaped like a real provider key, so secret scanners ignore it.
const KEY = "test-only-not-a-real-key";

type Call = { method: string; path: string; body?: unknown };

/** A stand-in for Langfuse that remembers what was created. */
function fakeLangfuse(start: { connections?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  const store: Record<string, Record<string, unknown>[]> = {
    "/api/public/llm-connections": [...(start.connections ?? [])],
    "/api/public/v2/evaluators": [],
    "/api/public/v2/evaluation-rules": [],
  };
  const request: LangfuseRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return { data: store[path] };
    const made = {
      id: `${path.split("/").at(-1)}-${store[path].length + 1}`,
      ...(body as object),
    };
    store[path].push(made);
    return made;
  };
  const writes = () => calls.filter((call) => call.method !== "GET");
  return { request, calls, writes };
}

const googleConnection = { provider: "my-google", adapter: "google-ai-studio" };

describe("the judge", () => {
  it("is asked about the customer's message and Copper's reply, and both are filled in", () => {
    expect(JUDGE_PROMPT).toContain("{{question}}");
    expect(JUDGE_PROMPT).toContain("{{answer}}");
    const used = [...JUDGE_PROMPT.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    expect(JUDGE_VARIABLES.map((v) => v.variable).sort()).toEqual(
      [...new Set(used)].sort(),
    );
    // The reply is the "reply" field of what ask.ts records as the output.
    expect(JUDGE_VARIABLES).toContainEqual({
      variable: "answer",
      source: "output",
      jsonPath: "$.reply",
    });
  });

  it("scores from 0 to 1 and gives a reason", () => {
    expect(JUDGE_SCORE).toMatchObject({
      dataType: "NUMERIC",
      minValue: 0,
      maxValue: 1,
    });
    expect(JUDGE_SCORE.scoreReasoningInstructions).toBeTruthy();
  });

  it("reads the top record of every Ask Copper turn, on both pages", () => {
    expect(JUDGED_TRACES).toEqual(["ask-copper", "support-chat"]);
    expect(JUDGE_FILTER).toContainEqual({
      type: "stringOptions",
      column: "name",
      operator: "any of",
      value: JUDGED_TRACES,
    });
    expect(JUDGE_FILTER).toContainEqual({
      type: "boolean",
      column: "isRootObservation",
      operator: "=",
      value: true,
    });
  });
});

describe("npm run judge:setup", () => {
  it("stops, creating nothing, when Langfuse has no Google AI key and none is shared", async () => {
    const langfuse = fakeLangfuse();
    expect(await setupJudge(langfuse.request)).toEqual({
      status: "needs-connection",
    });
    expect(langfuse.writes()).toEqual([]);
  });

  it("creates the evaluator and the rule on a connection that's already there, without sending a key", async () => {
    const langfuse = fakeLangfuse({ connections: [googleConnection] });
    const result = await setupJudge(langfuse.request, { googleKey: KEY });
    expect(result).toMatchObject({
      status: "ready",
      created: ["evaluator", "rule"],
    });
    expect(JSON.stringify(langfuse.calls)).not.toContain(KEY);

    const [evaluator, rule] = langfuse.writes();
    expect(evaluator.path).toBe("/api/public/v2/evaluators");
    expect(evaluator.body).toMatchObject({
      name: JUDGE_NAME,
      type: "llm_as_judge",
      prompt: JUDGE_PROMPT,
      // The connection's own name in Langfuse.
      modelConfig: { provider: "my-google", model: JUDGE_MODEL },
      outputDefinition: JUDGE_SCORE,
    });
    expect(rule.path).toBe("/api/public/v2/evaluation-rules");
    expect(rule.body).toMatchObject({
      name: JUDGE_NAME,
      enabled: true,
      sampling: 1,
      filter: JUDGE_FILTER,
      evaluatorAssignments: [
        { evaluatorId: "evaluators-1", variableMapping: JUDGE_VARIABLES },
      ],
    });
  });

  it("stores the Google AI key in Langfuse only when it's shared", async () => {
    const langfuse = fakeLangfuse();
    const result = await setupJudge(langfuse.request, { googleKey: KEY });
    expect(result).toMatchObject({
      status: "ready",
      created: ["connection", "evaluator", "rule"],
    });
    expect(langfuse.writes()[0]).toEqual({
      method: "PUT",
      path: "/api/public/llm-connections",
      body: {
        provider: "google",
        adapter: "google-ai-studio",
        secretKey: KEY,
        withDefaultModels: true,
        customModels: [JUDGE_MODEL],
      },
    });
  });

  it("changes nothing when run again", async () => {
    const langfuse = fakeLangfuse({ connections: [googleConnection] });
    const first = await setupJudge(langfuse.request);
    const before = langfuse.writes().length;
    const second = await setupJudge(langfuse.request);
    expect(langfuse.writes()).toHaveLength(before);
    expect(second).toMatchObject({ status: "ready", created: [] });
    expect(second).toMatchObject({
      evaluatorId: (first as { evaluatorId: string }).evaluatorId,
    });
  });
});

describe("npm run judge:scores", () => {
  it("asks Langfuse for the judge's scores and returns value, reason and trace", async () => {
    let asked = "";
    const request: LangfuseRequest = async (_method, path) => {
      asked = path;
      return {
        data: [
          {
            name: JUDGE_NAME,
            value: 0.75,
            comment: "Answers the question; no order number.",
            timestamp: "2026-11-19T22:10:00.000Z",
            subject: { kind: "observation", traceId: "trace-1" },
          },
        ],
      };
    };
    expect(await latestJudgeScores(request, 5)).toEqual([
      {
        value: 0.75,
        comment: "Answers the question; no order number.",
        timestamp: "2026-11-19T22:10:00.000Z",
        traceId: "trace-1",
      },
    ]);
    expect(asked).toContain("/api/public/v3/scores?");
    expect(asked).toContain(`name=${JUDGE_NAME}`);
    expect(asked).toContain("limit=5");
  });
});
