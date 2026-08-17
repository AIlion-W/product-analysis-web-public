import {
  toModelTaskResult,
  type ModelTaskApiSuccess,
  type ModelTaskResult,
} from "../lib/neigong/types";

export function narrowApiSuccess(value: ModelTaskApiSuccess): void {
  switch (value.task) {
    case "review-taxonomy":
      void value.result.labels[0]?.typeId;
      // @ts-expect-error review labels do not contain topicId.
      void value.result.labels[0]?.topicId;
      break;
    case "question-topic":
      void value.result.labels[0]?.topicId;
      // @ts-expect-error question labels do not contain typeId.
      void value.result.labels[0]?.typeId;
      break;
    case "top20-dimensions":
      void value.result.rows[0]?.dimensions.effect;
      // @ts-expect-error top20 output does not contain tags.
      void value.result.tags;
      break;
    case "screenshot-metadata":
      void value.result.tags[0]?.count;
      // @ts-expect-error screenshot output does not contain findings.
      void value.result.findings;
      break;
    case "synthesis":
      void value.result.findings[0]?.evidenceIds;
      // @ts-expect-error synthesis output does not contain rows.
      void value.result.rows;
      break;
  }
}

export function narrowQueueResult(value: ModelTaskResult): void {
  if (value.task === "review-taxonomy") {
    void value.output.labels[0]?.evidenceQuote;
    // @ts-expect-error review output does not contain rows.
    void value.output.rows;
  } else if (value.task === "question-topic") {
    void value.output.labels[0]?.topicEvidence;
    // @ts-expect-error question output does not contain tags.
    void value.output.tags;
  } else if (value.task === "top20-dimensions") {
    void value.output.rows[0]?.score;
    // @ts-expect-error top20 output does not contain productName.
    void value.output.productName;
  } else if (value.task === "screenshot-metadata") {
    void value.output.productName;
    // @ts-expect-error screenshot output does not contain actions.
    void value.output.actions;
  } else {
    // Actions are built deterministically from findings, never returned by the model.
    void value.output.findings[0]?.evidenceIds;
    // @ts-expect-error synthesis output does not contain actions.
    void value.output.actions;
    // @ts-expect-error synthesis output does not contain labels.
    void value.output.labels;
  }
}

export function mapDefaultUnion(value: ModelTaskApiSuccess): ModelTaskResult {
  return toModelTaskResult(value);
}
