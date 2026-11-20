// Module 5: the golden set. A fixed list of test questions for Ask Copper,
// each with what a good answer looks like (evals/golden-set.json). It's kept
// in Langfuse as a dataset, so the same questions can be asked again after
// every change and the answers compared (npm run golden:upload).
// "with { type: \"json\" }" lets the upload script, which runs in plain Node,
// read the file too.
import questions from "@/evals/golden-set.json" with { type: "json" };
import type { LangfuseRequest } from "@/lib/copper/judge";

export type GoldenQuestion = {
  /** A short name that never changes, so re-uploading updates the same row. */
  id: string;
  /** Where the customer asks: the home page chat or the Support page chat. */
  page: "home" | "support";
  category: string;
  question: string;
  /** What a good answer says and does, in plain English, for the judge. */
  expected: string;
};

/** The dataset's name in Langfuse. */
export const GOLDEN_DATASET = "ask-copper-golden";

export const GOLDEN_SET = questions as GoldenQuestion[];

/** One question as Langfuse stores it: input, expected output, metadata. */
export function datasetItem(question: GoldenQuestion) {
  return {
    // Ids are shared by the whole Langfuse project, so they carry the
    // dataset's name.
    id: `${GOLDEN_DATASET}-${question.id}`,
    datasetName: GOLDEN_DATASET,
    input: { question: question.question, page: question.page },
    expectedOutput: question.expected,
    metadata: { category: question.category },
  };
}

/**
 * Puts the golden set in Langfuse. Safe to run again: the dataset is made
 * once, and each question updates its own row.
 */
export async function uploadGoldenSet(
  request: LangfuseRequest,
): Promise<{ createdDataset: boolean; items: number }> {
  const datasets = (
    (await request("GET", "/api/public/v2/datasets?limit=100")) as {
      data?: { name: string }[];
    }
  ).data;
  const exists = datasets?.some((dataset) => dataset.name === GOLDEN_DATASET);
  if (!exists)
    await request("POST", "/api/public/v2/datasets", {
      name: GOLDEN_DATASET,
      description:
        "Ask Copper golden set: test questions with what a good answer looks like (evals/golden-set.json).",
    });
  for (const question of GOLDEN_SET)
    await request("POST", "/api/public/dataset-items", datasetItem(question));
  return { createdDataset: !exists, items: GOLDEN_SET.length };
}
