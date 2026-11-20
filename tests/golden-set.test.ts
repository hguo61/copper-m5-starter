// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getPlans, getProducts } from "@/lib/copper/catalog";
import {
  datasetItem,
  GOLDEN_DATASET,
  GOLDEN_SET,
  uploadGoldenSet,
} from "@/lib/copper/golden-set";
import type { LangfuseRequest } from "@/lib/copper/judge";
import { DEFAULT_LIMIT_USD, getOrders } from "@/lib/copper/orders";

const byId = (id: string) => GOLDEN_SET.find((q) => q.id === id)!;

describe("the golden set", () => {
  it("has questions for both pages, each with its own id and an expected answer", () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(8);
    expect(new Set(GOLDEN_SET.map((q) => q.id)).size).toBe(GOLDEN_SET.length);
    for (const q of GOLDEN_SET) {
      expect(q.id).toMatch(/^[a-z0-9-]+$/);
      expect(["home", "support"]).toContain(q.page);
      expect(q.question.trim().length).toBeGreaterThan(10);
      expect(q.expected.trim().length).toBeGreaterThan(20);
      expect(q.category).toBeTruthy();
    }
    expect(new Set(GOLDEN_SET.map((q) => q.page))).toEqual(
      new Set(["home", "support"]),
    );
  });

  it("expects the prices, colors and orders the app really has", () => {
    const home = getProducts().find((p) => p.id === "copper-home")!;
    const notes = getProducts().find((p) => p.id === "copper-notes")!;
    const plus = getPlans().find((p) => p.id === "copper-plus")!;
    expect(byId("price-home-plus-2-years").expected).toContain(
      `$${home.priceUsd + 2 * plus.annualUsd}`,
    );
    for (const color of notes.colors)
      expect(byId("colors-notes").expected).toContain(color);

    const order = (id: string) => getOrders().find((o) => o.id === id)!;
    const under = byId("refund-under-limit").expected;
    expect(under).toContain(`$${order("1001").amountUsd}`);
    expect(order("1001").amountUsd).toBeLessThanOrEqual(DEFAULT_LIMIT_USD);
    const over = byId("refund-over-limit").expected;
    expect(over).toContain(`$${order("1004").amountUsd}`);
    expect(order("1004").amountUsd).toBeGreaterThan(DEFAULT_LIMIT_USD);
    expect(getOrders().some((o) => o.id === "9999")).toBe(false);
  });
});

describe("npm run golden:upload", () => {
  function fakeLangfuse(datasets: { name: string }[] = []) {
    const writes: { path: string; body: unknown }[] = [];
    const request: LangfuseRequest = async (method, path, body) => {
      if (method === "GET") return { data: datasets };
      writes.push({ path, body });
      return {};
    };
    return { request, writes };
  }

  it("creates the dataset, then one item per question with its input, expected answer and category", async () => {
    const langfuse = fakeLangfuse();
    expect(await uploadGoldenSet(langfuse.request)).toEqual({
      createdDataset: true,
      items: GOLDEN_SET.length,
    });
    const [dataset, ...items] = langfuse.writes;
    expect(dataset.path).toBe("/api/public/v2/datasets");
    expect(dataset.body).toMatchObject({ name: GOLDEN_DATASET });
    expect(items).toHaveLength(GOLDEN_SET.length);
    expect(items[0]).toEqual({
      path: "/api/public/dataset-items",
      body: {
        id: `${GOLDEN_DATASET}-${GOLDEN_SET[0].id}`,
        datasetName: GOLDEN_DATASET,
        input: { question: GOLDEN_SET[0].question, page: GOLDEN_SET[0].page },
        expectedOutput: GOLDEN_SET[0].expected,
        metadata: { category: GOLDEN_SET[0].category },
      },
    });
  });

  it("doesn't create the dataset twice, and updates the same rows", async () => {
    const langfuse = fakeLangfuse([{ name: GOLDEN_DATASET }]);
    const result = await uploadGoldenSet(langfuse.request);
    expect(result.createdDataset).toBe(false);
    expect(langfuse.writes.map((w) => w.path)).toEqual(
      GOLDEN_SET.map(() => "/api/public/dataset-items"),
    );
    expect(datasetItem(GOLDEN_SET[0]).id).toBe(datasetItem(GOLDEN_SET[0]).id);
  });
});
