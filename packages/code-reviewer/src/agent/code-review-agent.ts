import { NoObjectGeneratedError, Output, ToolLoopAgent, TypeValidationError, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import {
  buildCodeReviewPrompt,
  codeReviewInstructionVariants,
  defaultPromptVariant,
  type CodeReviewPromptVariant,
  type CodeReviewTarget,
} from "../prompts/code-review.js";
import { codeReviewSchema, type CodeReview } from "../schemas/code-review.js";
import { createReviewModel } from "../services/model.js";
import { createFileTools } from "../tools/index.js";
import { createWorkspace } from "../tools/workspace.js";
import { getConfig } from "../utils/config.js";
import { CodeReviewError } from "./errors.js";
import { createTracingCallbacks } from "./tracing.js";

export type { CodeReviewTarget } from "../prompts/code-review.js";

/**
 * Everything a prompt eval would want to sweep. All optional: with no options
 * this is the CLI's reviewer, and each field falls back to `config.json`.
 */
export interface CodeReviewAgentOptions {
  /** A model id for OpenRouter, or a ready-made model - a mock, for instance. */
  model?: string | LanguageModel;
  promptVariant?: CodeReviewPromptVariant;
  /** The only directory the tools may read. Defaults to the process cwd. */
  workspaceRoot?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Total steps, output step included: a budget of N allows N-1 tool steps. */
  maxSteps?: number;
  maxRetries?: number;
  /**
   * Milliseconds allowed for a single model call, not for the whole loop.
   * A tool loop makes several calls, so a total budget this size would abort a
   * healthy run partway through.
   */
  timeout?: number;
  maxFileBytes?: number;
  maxSearchResults?: number;
}

export type CodeReviewerOptions = CodeReviewAgentOptions;

export interface CodeReviewer {
  agent: ReturnType<typeof createCodeReviewAgent>;
  review(target: CodeReviewTarget): Promise<CodeReview>;
}

function resolveModel(model: string | LanguageModel | undefined): LanguageModel {
  if (model === undefined) {
    return createReviewModel(getConfig().model);
  }
  // A string is an id to look up; anything else is already a model.
  return typeof model === "string" ? createReviewModel(model) : model;
}

function describeModel(model: string | LanguageModel | undefined): string {
  if (model === undefined) {
    return getConfig().model;
  }
  if (typeof model === "string") {
    return model;
  }
  return "modelId" in model ? model.modelId : "injected model";
}

export function createCodeReviewAgent(options: CodeReviewAgentOptions = {}) {
  const config = getConfig();
  const promptVariant = options.promptVariant ?? defaultPromptVariant;
  const maxSteps = options.maxSteps ?? config.maxSteps;
  const perCallTimeoutMs = options.timeout ?? config.requestTimeoutMs;

  // The root is captured by closure here, so no tool can exist without it.
  const workspace = createWorkspace(options.workspaceRoot ?? process.cwd(), {
    maxFileBytes: options.maxFileBytes ?? config.maxFileBytes,
    maxSearchResults: options.maxSearchResults ?? config.maxSearchResults,
  });

  return new ToolLoopAgent({
    model: resolveModel(options.model),
    instructions: codeReviewInstructionVariants[promptVariant],
    tools: createFileTools(workspace),
    output: Output.object({ schema: codeReviewSchema }),
    // Producing the structured object costs a step of its own.
    stopWhen: isStepCount(maxSteps),
    temperature: options.temperature ?? config.temperature,
    maxOutputTokens: options.maxOutputTokens ?? config.maxOutputTokens,
    maxRetries: options.maxRetries ?? config.maxRetries,
    // A bare number here would be the TOTAL for the whole loop, which killed a
    // real run at 120s mid-review. Per-step is what requestTimeoutMs means; the
    // total is derived so it always scales with the step budget.
    timeout: { stepMs: perCallTimeoutMs, totalMs: perCallTimeoutMs * maxSteps },
    ...createTracingCallbacks({
      modelId: describeModel(options.model),
      promptVariant,
      workspaceRoot: workspace.root,
    }),
  });
}

/**
 * A reviewer is immutable and safe to reuse across a fixture set: build one per
 * variant, then push the same targets through each.
 */
export function createCodeReviewer(options: CodeReviewerOptions = {}): CodeReviewer {
  const agent = createCodeReviewAgent(options);

  async function review(target: CodeReviewTarget): Promise<CodeReview> {
    const label = target.kind === "diff" ? target.title : target.kind === "file" ? target.path : target.fileName;
    const prompt = buildCodeReviewPrompt(target);

    let result;
    try {
      result = await agent.generate({ prompt });
    } catch (error) {
      throw asCodeReviewError(error, label);
    }

    try {
      return result.output;
    } catch (error) {
      // `.output` throws when the run never finished with "stop", which is what
      // an exhausted step budget looks like from here.
      throw new CodeReviewError({
        reason: "step-budget-exhausted",
        message:
          `Reviewing ${label} ran out of steps after ${result.steps.length} step(s) ` +
          `without producing a review. Raise maxSteps or narrow the target.`,
        cause: error,
        steps: result.steps.length,
        usage: result.usage,
      });
    }
  }

  return { agent, review };
}

function asCodeReviewError(error: unknown, label: string): CodeReviewError {
  if (CodeReviewError.isInstance(error)) {
    return error;
  }

  if (NoObjectGeneratedError.isInstance(error) || TypeValidationError.isInstance(error)) {
    return new CodeReviewError({
      reason: "invalid-output",
      message: `Reviewing ${label} produced output the review schema rejected.`,
      cause: error,
    });
  }

  return new CodeReviewError({
    reason: "provider-error",
    message: `Reviewing ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

/** Convenience for the CLI and for fixtures: a path becomes a file target. */
export function fileTarget(path: string): CodeReviewTarget {
  return { kind: "file", path };
}

/** Convenience for fixtures that carry their code as a string. */
export function inlineTarget(fileName: string, code: string): CodeReviewTarget {
  return { kind: "inline", fileName, code };
}

/** Convenience for the CI entrypoint: a PR title/diff (and optional description) becomes a target. */
export function diffTarget(title: string, diff: string, description?: string): CodeReviewTarget {
  return { kind: "diff", title, diff, description };
}
