import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  setLangfuseTracerProvider,
  startActiveObservation,
} from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { MODELS, type ModelId } from "@/lib/ai/models";
import { costUsd, PRICING } from "@/lib/ai/pricing";

// Module 5: observability. Every model call in the app is traced in Langfuse:
// which agent ran, each step, each tool call, the tokens, the cost and how
// long it took. Nothing here runs until the Langfuse keys are set, so the app
// still works with no keys.
//
// How it fits together:
// - The AI SDK reports each call, step and tool call to the Langfuse
//   integration, which turns them into spans (timed, nested records).
// - CostProcessor adds this app's own cost estimate (lib/ai/pricing.ts) to
//   each model call, so Langfuse shows the same cost as the [ai_calls] log.
// - LangfuseSpanProcessor sends the spans to Langfuse.

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/** Google's model name (what the span carries) → this app's model id. */
function modelIdFor(googleName: unknown): ModelId | undefined {
  if (typeof googleName !== "string") return undefined;
  const name = googleName.replace(/^models\//, "");
  return MODELS.find((m) => m.googleId === name || m.id === name)?.id;
}

/**
 * The cost of one model call, from its span. Only the model call itself
 * ("chat") is priced: the spans around it (the step, the agent) repeat its
 * tokens, and pricing those too would count the cost twice.
 */
export function costDetailsFor(
  attributes: Record<string, unknown>,
): { input: number; output: number; total: number } | undefined {
  if (attributes["gen_ai.operation.name"] !== "chat") return undefined;
  const model = modelIdFor(
    attributes["gen_ai.response.model"] ?? attributes["gen_ai.request.model"],
  );
  const input = attributes["gen_ai.usage.input_tokens"];
  const output = attributes["gen_ai.usage.output_tokens"];
  if (!model || typeof input !== "number" || typeof output !== "number")
    return undefined;
  const price = PRICING[model];
  return {
    input: (input * price.input) / 1_000_000,
    output: (output * price.output) / 1_000_000,
    total: costUsd(model, input, output),
  };
}

/** Langfuse reads a model call's cost from this span attribute (as JSON). */
const COST_ATTRIBUTE = "langfuse.observation.cost_details";

/**
 * Adds the cost to each finished model call. The tokens are only known when
 * the call ends, and OpenTelemetry has no "about to end" step in this
 * version, so the cost is written onto the finished span's attributes just
 * before the Langfuse processor (next in line) reads them.
 */
export class CostProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const cost = costDetailsFor(span.attributes);
    if (cost)
      (span.attributes as Record<string, unknown>)[COST_ATTRIBUTE] =
        JSON.stringify(cost);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

// Kept on globalThis: Next.js loads instrumentation.ts and the app's own code
// as separate copies of this file, and both need the same processor.
const shared = globalThis as { __copperLangfuse?: LangfuseSpanProcessor };

/**
 * Starts sending traces to Langfuse. Called once when the server starts
 * (instrumentation.ts). Does nothing without the Langfuse keys, or if it has
 * already started.
 */
export function startTracing(
  /** Tests pass their own exporter, to read the spans instead of sending them. */
  exporter?: SpanExporter,
  /**
   * Scripts (npm run golden:run) set this: Langfuse's experiment runner looks
   * for the app-wide tracing setup. The app itself leaves it off.
   */
  appWide = false,
): boolean {
  if (shared.__copperLangfuse) return true;
  if (!isTracingConfigured()) return false;

  const langfuse = new LangfuseSpanProcessor({
    exporter,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY?.trim(),
    secretKey: process.env.LANGFUSE_SECRET_KEY?.trim(),
    baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || undefined,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });
  shared.__copperLangfuse = langfuse;
  const provider = new NodeTracerProvider({
    spanProcessors: [new CostProcessor(), langfuse],
  });

  // Only AI spans go through this provider. It isn't registered as the
  // app-wide one, so Next.js's own request spans stay out of Langfuse.
  setLangfuseTracerProvider(provider);
  if (appWide) trace.setGlobalTracerProvider(provider);
  // Lets a span find its parent across awaits (a tool call inside a step
  // inside an agent inside one Ask Copper turn).
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  registerTelemetry(
    new LangfuseVercelAiSdkIntegration({ tracer: provider.getTracer("ai") }),
  );
  return true;
}

/** Sends any traces still waiting. Safe to call when tracing is off. */
export async function flushTracing(): Promise<void> {
  try {
    await shared.__copperLangfuse?.forceFlush();
  } catch (error) {
    // Tracing must never break the app.
    console.warn("[langfuse] could not send traces:", error);
  }
}

export type TraceInfo = {
  /** The trace's name in Langfuse, e.g. "ask-copper". */
  name: string;
  input?: unknown;
  /** Groups the traces of one conversation. */
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

/**
 * Runs `fn` as one trace: every model call inside it shows up under the same
 * trace in Langfuse. Call `setOutput` with the final answer. Without the
 * Langfuse keys it just runs `fn`.
 * Example: traced({ name: "ask-copper", input: question }, async (setOutput) => { ... })
 */
export async function traced<T>(
  info: TraceInfo,
  fn: (setOutput: (output: unknown) => void) => Promise<T>,
): Promise<T> {
  if (!shared.__copperLangfuse) return fn(() => {});
  return startActiveObservation(
    info.name,
    (span) => {
      span.update({ input: info.input });
      return propagateAttributes(
        {
          traceName: info.name,
          sessionId: info.sessionId,
          tags: info.tags,
          metadata: info.metadata,
        },
        () => fn((output) => span.update({ output })),
      );
    },
    { asType: "agent" },
  );
}
