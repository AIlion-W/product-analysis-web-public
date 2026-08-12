import {
  buildReportData,
  buildSynthesisFacts,
} from "../../lib/neigong/report-builder.ts";

const DIMENSIONS = ["persona", "scene", "painPoint", "detail", "effect", "delight"];

function review(productId, sort, rank) {
  const text = `${productId}-${sort}-评价-${rank}`;
  return {
    rowId: `${productId}-${sort}-${rank}`,
    sourceId: `${productId}:${sort}_reviews`,
    sourceRow: rank + 1,
    productId,
    sort,
    rank,
    date: "2026-08-11",
    sku: "",
    initialText: text,
    followupText: "",
    normalizedText: text,
  };
}

function question(productId, rank) {
  const text = `${productId}-问题-${rank}`;
  return {
    rowId: `${productId}-question-${rank}`,
    sourceId: `${productId}:questions`,
    sourceRow: rank + 1,
    productId,
    rank,
    questionText: text,
    answer: "回答",
    date: "2026-08-11",
    normalizedText: text,
  };
}

function statusFor(count) {
  if (count === 0) return "missing";
  if (count < 90) return "insufficient";
  if (count < 100) return "provisional";
  return "complete";
}

function source(productId, kind, count) {
  return {
    sourceId: `${productId}:${kind}`,
    productId,
    kind,
    rowsRead: count,
    validRows: count,
    usedRows: count,
    excludedRows: 0,
    excludedOverLimit: 0,
    status: statusFor(count),
    note: "fixture",
  };
}

function result(task, requestId, output) {
  return { task, requestId, output, errors: [], warnings: [] };
}

function createPack({
  productId,
  role,
  name,
  defaultCount,
  recentCount,
  questionCount,
}) {
  const reviews = [
    ...Array.from({ length: defaultCount }, (_, index) => review(productId, "default", index + 1)),
    ...Array.from({ length: recentCount }, (_, index) => review(productId, "recent", index + 1)),
  ];
  const questions = Array.from({ length: questionCount }, (_, index) => question(productId, index + 1));
  return {
    product: { productId, role, name },
    reviews,
    questions,
    sources: [
      source(productId, "default_reviews", defaultCount),
      source(productId, "recent_reviews", recentCount),
      source(productId, "questions", questionCount),
    ],
    sourceMappings: [],
    excludedRows: [],
    errors: [],
    warnings: [],
  };
}

function resultsForPack(pack, lowDimension) {
  const productId = pack.product.productId;
  const reviewLabels = pack.reviews.map((entry) => ({
    rowId: entry.rowId,
    typeId: entry.rank <= 40
      ? "t1"
      : entry.sort === "default"
        ? entry.rank <= 80 ? "t2" : entry.rank <= 90 ? "t3" : "t4"
        : entry.rank <= 60 ? "t2" : entry.rank <= 80 ? "t3" : "t4",
    evidenceSource: "initial",
    evidenceQuote: entry.initialText,
  }));
  const questionLabels = pack.questions.map((entry) => ({
    rowId: entry.rowId,
    topicId: "q1",
    topicEvidence: entry.questionText,
  }));
  const top20Rows = pack.reviews
    .filter((entry) => entry.sort === "default")
    .slice(0, 20)
    .map((entry, index) => {
      const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [
        dimension,
        dimension !== lowDimension || index < 4,
      ]));
      return {
        rowId: entry.rowId,
        dimensions,
        evidence: Object.fromEntries(DIMENSIONS.map((dimension) => [
          dimension,
          dimensions[dimension] ? entry.initialText : "",
        ])),
        score: Object.values(dimensions).filter(Boolean).length,
        note: "",
      };
    });
  return {
    [`review-taxonomy:${productId}:all`]: result("review-taxonomy", `review-taxonomy:${productId}:all`, { labels: reviewLabels }),
    [`question-topic:${productId}:all`]: result("question-topic", `question-topic:${productId}:all`, { labels: questionLabels }),
    [`top20-dimensions:${productId}`]: result("top20-dimensions", `top20-dimensions:${productId}`, { rows: top20Rows }),
  };
}

export function createValidNeigongReport({
  ownDefault = 100,
  ownRecent = 100,
  ownQuestions = 100,
  lowDimension,
  competitors = [],
} = {}) {
  const packs = [
    createPack({
      productId: "own",
      role: "self",
      name: "我方产品",
      defaultCount: ownDefault,
      recentCount: ownRecent,
      questionCount: ownQuestions,
    }),
    ...competitors.map((competitor, index) => createPack({
      productId: competitor.productId ?? `rival-${index + 1}`,
      role: "competitor",
      name: competitor.name ?? `竞品 ${index + 1}`,
      defaultCount: competitor.defaultCount ?? 100,
      recentCount: competitor.recentCount ?? 100,
      questionCount: competitor.questionCount ?? 100,
    })),
  ];
  const results = Object.assign({}, ...packs.map((pack) => resultsForPack(
    pack,
    pack.product.role === "self" ? lowDimension : undefined,
  )));
  const facts = buildSynthesisFacts({ packs, results });
  const synthesis = {
    findings: facts.readiness.map((entry) => ({
      id: entry.findingId,
      status: entry.status,
      evidenceIds: entry.evidenceIds,
    })),
  };
  return buildReportData({
    packs,
    results,
    synthesis,
    generatedAt: "2026-08-11T00:00:00.000Z",
  });
}
