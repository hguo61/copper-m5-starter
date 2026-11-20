// npm run judge:setup: sets up the AI judge in your Langfuse project (run it
// once; running it again changes nothing). Langfuse's LLM-as-a-judge then
// scores every Ask Copper reply. What it sets up is in lib/copper/judge.ts.
//
// Langfuse runs the judge itself, so it needs a Google AI key of its own.
// Add one in Langfuse (Settings > LLM Connections > Google AI Studio), or run
//   npm run judge:setup -- --share-google-key
// to store the key from .env.local in your Langfuse project.
//
// npm run judge:scores: prints the judge's latest scores and reasons.
//
// npm run golden:upload: puts the golden set of test questions
// (evals/golden-set.json) in Langfuse as a dataset. Run it again after
// changing the file.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// The app's TypeScript files import each other as "@/lib/...": point Node at
// them, and tell it they're ES modules so it doesn't print a warning.
const root = new URL("../", import.meta.url);
registerHooks({
  resolve: (specifier, context, next) =>
    next(
      specifier.startsWith("@/")
        ? new URL(
            specifier.slice(2) + (specifier.endsWith(".json") ? "" : ".ts"),
            root,
          ).href
        : specifier,
      context,
    ),
  load: (url, context, next) =>
    next(
      url,
      url.endsWith(".ts")
        ? { ...context, format: "module-typescript" }
        : context,
    ),
});

function fail(message) {
  console.error(`judge: ${message}`);
  process.exit(1);
}

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
if (!publicKey || !secretKey)
  fail(
    "add LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to .env.local first (the README says where to find them).",
  );
const base = (
  process.env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com"
).replace(/\/$/, "");
const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;

async function request(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok)
    fail(
      `Langfuse answered ${response.status} to ${method} ${path}: ${text.slice(0, 500)}`,
    );
  return text ? JSON.parse(text) : {};
}

const { JUDGE_NAME, latestJudgeScores, setupJudge } =
  await import("@/lib/copper/judge");
const [command = "setup", ...flags] = process.argv.slice(2);

if (command === "scores") {
  const scores = await latestJudgeScores(request);
  if (scores.length === 0)
    console.log(
      `No "${JUDGE_NAME}" scores yet. Ask Copper a question, wait a minute, and run this again.`,
    );
  for (const score of scores)
    console.log(
      `${score.timestamp}  ${score.value.toFixed(2)}  ${score.comment ?? ""}`,
    );
} else if (command === "setup") {
  const share = flags.includes("--share-google-key");
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (share && !googleKey)
    fail("add GOOGLE_GENERATIVE_AI_API_KEY to .env.local first.");
  const result = await setupJudge(request, {
    googleKey: share ? googleKey : undefined,
  });
  if (result.status === "needs-connection") {
    console.log(
      [
        "Langfuse needs a Google AI key to run the judge, and your project has none yet.",
        "Either add one in Langfuse: Settings > LLM Connections > Add > Google AI Studio,",
        "or run: npm run judge:setup -- --share-google-key",
        "(that stores the key from .env.local in your Langfuse project).",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(
    result.created.length
      ? `Set up in Langfuse: ${result.created.join(", ")}.`
      : "Already set up; nothing changed.",
  );
  console.log(
    `The judge "${JUDGE_NAME}" now scores every Ask Copper reply. See the scores in Langfuse (${base}) under Scores, or run: npm run judge:scores`,
  );
} else if (command === "golden") {
  const { GOLDEN_DATASET, uploadGoldenSet } =
    await import("@/lib/copper/golden-set");
  const result = await uploadGoldenSet(request);
  console.log(
    `${result.createdDataset ? "Created" : "Updated"} the dataset "${GOLDEN_DATASET}" with ${result.items} questions. See it in Langfuse (${base}) under Datasets.`,
  );
} else {
  fail(`unknown command "${command}". Use setup, scores or golden.`);
}
