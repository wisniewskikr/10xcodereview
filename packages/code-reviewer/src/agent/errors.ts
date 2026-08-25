import type { LanguageModelUsage } from "ai";

/**
 * Why a review failed. The distinction matters downstream: a future eval must
 * never score an exhausted step budget the same way as a clean "no findings".
 */
export type CodeReviewErrorReason =
  /** The loop ran out of steps before it produced the structured output. */
  | "step-budget-exhausted"
  /** The model answered, but not with something the schema accepts. */
  | "invalid-output"
  /** The provider, the network, or the request itself failed. */
  | "provider-error";

/**
 * Marker on the instance rather than a bare `instanceof`: two copies of this
 * module (a dist/ build alongside a tsx run, say) would each have their own
 * class identity, and `instanceof` would quietly say no.
 */
const marker = Symbol.for("10xcodereview.error.CodeReviewError");

export class CodeReviewError extends Error {
  readonly reason: CodeReviewErrorReason;
  /** Steps the run got through, when the run got far enough to have any. */
  readonly steps: number | undefined;
  readonly usage: LanguageModelUsage | undefined;

  constructor(options: {
    reason: CodeReviewErrorReason;
    message: string;
    cause?: unknown;
    steps?: number;
    usage?: LanguageModelUsage;
  }) {
    super(options.message, { cause: options.cause });

    this.name = "CodeReviewError";
    this.reason = options.reason;
    this.steps = options.steps;
    this.usage = options.usage;

    Object.defineProperty(this, marker, { value: true, enumerable: false });
  }

  static isInstance(error: unknown): error is CodeReviewError {
    return typeof error === "object" && error !== null && marker in error;
  }
}
