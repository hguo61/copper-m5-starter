// Next.js runs register() once when the server starts. Module 5: it starts
// Langfuse tracing (lib/ai/tracing.ts) when the Langfuse keys are set.
export async function register() {
  // Tracing uses Node.js features, so it's skipped on the Edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTracing } = await import("@/lib/ai/tracing");
  startTracing();
}
