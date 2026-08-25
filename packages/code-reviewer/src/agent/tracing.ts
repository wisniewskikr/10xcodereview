import { log } from "../utils/logger.js";

/**
 * Lifecycle tracing for the review loop, wired once at construction.
 *
 * The callbacks are typed structurally rather than against the SDK's event
 * types: a handler that asks for fewer properties is assignable where one
 * asking for more is expected, which keeps this module independent of the
 * agent's generic parameters.
 *
 * Nothing here logs a tool *result*. A tool result is file text, and writing it
 * to logs/*.log would recreate on disk exactly the exposure the workspace guard
 * exists to prevent.
 */

/** Input keys worth tracing. An allowlist, so a tool's output can never leak in. */
const tracedInputKeys = ["path", "query", "filePattern", "startLine", "endLine", "caseSensitive"];

function describeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "";
  }

  const record = input as Record<string, unknown>;
  const parts = tracedInputKeys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(record[key])}`);

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function describeUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): string {
  return `${usage.inputTokens ?? 0} in + ${usage.outputTokens ?? 0} out tokens`;
}

export interface TracingContext {
  modelId: string;
  promptVariant: string;
  workspaceRoot: string;
}

export function createTracingCallbacks(context: TracingContext) {
  return {
    onStart: (event: { callId: string }): void => {
      log.info(
        `[${event.callId}] review start: model=${context.modelId} ` +
          `prompt=${context.promptVariant} workspace=${context.workspaceRoot}`,
      );
    },

    onStepStart: (event: { callId: string; stepNumber: number }): void => {
      log.info(`[${event.callId}] step ${event.stepNumber} start`);
    },

    onToolExecutionEnd: (event: {
      callId: string;
      toolExecutionMs: number;
      toolCall: { toolName: string; input: unknown };
      toolOutput: { type: string };
    }): void => {
      const outcome = event.toolOutput.type === "tool-error" ? "rejected" : "ok";
      log.info(
        `[${event.callId}] tool ${event.toolCall.toolName}` +
          `${describeToolInput(event.toolCall.input)} -> ${outcome} ` +
          `in ${Math.round(event.toolExecutionMs)}ms`,
      );
    },

    onStepEnd: (event: {
      callId: string;
      stepNumber: number;
      finishReason: string;
      usage: { inputTokens: number | undefined; outputTokens: number | undefined };
      toolCalls: ReadonlyArray<{ toolName: string }>;
    }): void => {
      const calls =
        event.toolCalls.length === 0
          ? "no tool calls"
          : `called ${event.toolCalls.map((call) => call.toolName).join(", ")}`;

      log.info(
        `[${event.callId}] step ${event.stepNumber} end: ${event.finishReason}, ` +
          `${calls}, ${describeUsage(event.usage)}`,
      );
    },

    onEnd: (event: {
      callId: string;
      finishReason: string;
      steps: ReadonlyArray<unknown>;
      usage: { inputTokens: number | undefined; outputTokens: number | undefined };
    }): void => {
      log.info(
        `[${event.callId}] review end: ${event.finishReason} after ${event.steps.length} step(s), ` +
          `${describeUsage(event.usage)}`,
      );
    },
  };
}
