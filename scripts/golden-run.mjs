// npm run golden:run: asks Ask Copper every question in the golden set and
// has the AI judge grade each reply (lib/copper/experiment.ts). The run and
// its scores are kept in Langfuse under Datasets > ask-copper-golden.
// Run npm run golden:upload first, so the dataset is in Langfuse.
//
//   npm run golden:run                       run and print the scores
//   npm run golden:run -- --min-average 0.8  also fail when the average is lower
//   npm run golden:run -- --label two-agents name the run, to compare runs later
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// The app's TypeScript files import each other as "@/lib/..." and import JSON
// files: point Node at them, tell it they're ES modules so it doesn't print a
// warning, and tell it which imports are JSON.
const root = new URL("../", import.meta.url);
registerHooks({
  resolve: (specifier, context, next) => {
    const resolved = next(
      specifier.startsWith("@/")
        ? new URL(
            specifier.slice(2) + (specifier.endsWith(".json") ? "" : ".ts"),
            root,
          ).href
        : specifier,
      context,
    );
    return resolved.url.endsWith(".json")
      ? { ...resolved, importAttributes: { type: "json" } }
      : resolved;
  },
  load: (url, context, next) =>
    next(
      url,
      url.endsWith(".ts")
        ? { ...context, format: "module-typescript" }
        : context,
    ),
});

function fail(message) {
  console.error(`golden:run: ${message}`);
  process.exit(1);
}

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
for (const name of [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
])
  if (!process.env[name]?.trim())
    fail(`add ${name} to .env.local first (the README says where to find it).`);

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const minAverage = flag("--min-average");
if (
  minAverage !== undefined &&
  !(Number(minAverage) >= 0 && Number(minAverage) <= 1)
)
  fail("--min-average needs a number from 0 to 1, like 0.8.");

const { LangfuseClient } = await import("@langfuse/client");
const { flushTracing, startTracing } = await import("@/lib/ai/tracing");
const { GOLDEN_DATASET } = await import("@/lib/copper/golden-set");
const { runGoldenExperiment } = await import("@/lib/copper/experiment");

// The app prints one [ai_calls] line per model call; here that would bury the
// results.
console.info = () => {};

startTracing(undefined, true);
const langfuse = new LangfuseClient({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY.trim(),
  secretKey: process.env.LANGFUSE_SECRET_KEY.trim(),
  baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || undefined,
});

let dataset;
try {
  dataset = await langfuse.dataset.get(GOLDEN_DATASET);
} catch {
  fail(
    `the dataset "${GOLDEN_DATASET}" isn't in Langfuse yet. Run: npm run golden:upload`,
  );
}

console.log(
  `Asking ${dataset.items.length} questions, one at a time. This takes a minute or two.`,
);
const result = await runGoldenExperiment(dataset, { label: flag("--label") });
await flushTracing();
await langfuse.flush();

for (const row of result.rows)
  console.log(
    `${row.score === null ? " n/a" : row.score.toFixed(2)}  ${row.question}\n      ${row.reason}`,
  );
console.log(
  `\nAverage: ${result.average.toFixed(2)} over ${result.rows.length} questions (run "${result.runName}").`,
);
if (result.url) console.log(`See it in Langfuse: ${result.url}`);

if (minAverage !== undefined && result.average < Number(minAverage)) {
  console.error(
    `golden:run: the average ${result.average.toFixed(2)} is below ${minAverage}.`,
  );
  process.exit(1);
}
process.exit(0);
