import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import type { ApiProvider, ProviderOptions, ProviderResponse } from "promptfoo";
import { computeVerdict, createCodeReviewer, diffTarget } from "../src/agent/index.js";
import type { CodeReview } from "../src/agent/index.js";

/**
 * promptfoo custom provider: bridges promptfoo's "prompt string -> provider"
 * model to the code-review agent's structured `diff` target.
 *
 * The prompt from promptfoo is ignored - the review target is assembled from the
 * dataset row in `context.vars` ({ title, description, diff }). The review comes
 * back as a JSON string so `is-json` and the `.mjs` assertion can re-parse it.
 *
 * One provider entry per model: `config.model` is an OpenRouter slug for the
 * real columns, and `config.mock: true` selects a deterministic canned review
 * that needs no API key.
 */

const fixtureRoot = fileURLToPath(new URL("./fixtures/react19-migration", import.meta.url));

interface ProviderConfig {
  model?: string;
  promptVariant?: "default" | "evidence-first";
  maxSteps?: number;
  mock?: boolean;
}

/** A canned review that fails the verdict and names all three golden flaws. */
const MOCK_REVIEW: CodeReview = {
  summary:
    "The class-to-hooks migration is mostly sound, but it introduces three correctness regressions " +
    "in src/components/UserActivityFeed.tsx: a stale-closure unread counter, a subscription effect " +
    "with no cleanup, and a useEffect whose dependency array omits `events`.",
  criteria: {
    implementationCorrectness: {
      grade: 2,
      justification:
        "Three behavioural regressions against the class version: setUnread(unread - 1) after an " +
        "await reads a stale closure value instead of a functional updater; the subscription " +
        "useEffect never returns its unsubscribe function; the persistLastSeen useEffect reads " +
        "`events` but lists only `[userId]` as dependencies.",
    },
    idiomaticity: {
      grade: 6,
      justification: "Hook usage is conventional apart from the three defects.",
    },
    complexity: { grade: 7, justification: "Flat and readable; the component is small." },
    testCoverage: { grade: 3, justification: "No tests accompany a migration that changed effect semantics." },
    documentation: { grade: 6, justification: "Prop types moved to a TS interface; no stale comments." },
    securityAndSafety: { grade: 7, justification: "No secrets or injection surface; the createRoot null guard is fine." },
  },
  findings: [
    {
      file: "src/components/UserActivityFeed.tsx",
      line: 45,
      severity: "error",
      title: "Unread counter is written from a stale closure value, not a functional updater",
      explanation:
        "markOneRead calls setUnread(unread - 1) after `await api.markRead(...)`. `unread` is captured " +
        "from the render that created the handler. Under React 19 the post-await update is automatically " +
        "batched together with the setUnread(prev => prev + 1) calls the stream subscription runs during " +
        "the await, so those increments are silently overwritten and the badge under-counts (and can go " +
        "negative). markAllRead's setUnread(0) has the same stale-base problem.",
      suggestion: "Use setUnread(prev => prev - 1) so concurrent increments are preserved.",
    },
    {
      file: "src/components/UserActivityFeed.tsx",
      line: 19,
      severity: "error",
      title: "Subscription useEffect never returns its unsubscribe function",
      explanation:
        "activityStream.subscribe returns an unsubscribe handle, but the effect assigns it to a local " +
        "and returns nothing. Old listeners are never torn down on a userId change or on unmount, so " +
        "callbacks keep firing setState on an unmounted tree. React 19 StrictMode mounts the effect " +
        "twice, so even the first mount leaves two live subscriptions and every event is double-counted.",
      suggestion: "Return () => unsubscribe() from the effect.",
    },
    {
      file: "src/components/UserActivityFeed.tsx",
      line: 38,
      severity: "error",
      title: "persistLastSeen useEffect omits `events` from its dependency array",
      explanation:
        "The effect calls api.persistLastSeen(userId, events[0].id) but its dependency array is " +
        "[userId]. It runs once when userId is set - while `events` is still empty, so it early-returns - " +
        "and never re-runs as new events arrive. The server 'last seen' marker never advances and other " +
        "devices never catch up. The class version re-checked the newest event in componentDidUpdate.",
      suggestion: "Add `events` to the dependency array and read events[0]?.id.",
    },
  ],
};

function mockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(MOCK_REVIEW) }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

export default class CodeReviewerProvider implements ApiProvider {
  /**
   * The per-column name. promptfoo does NOT pass the yaml `label:` into the
   * constructor - it assigns it here afterwards via `provider.label ||= label`,
   * so this MUST start falsy or that assignment (and `--filter-providers`, which
   * regex-matches `id()`/`label`) silently misses. See loadApiProvider in
   * promptfoo's providers module.
   */
  label = "";
  private readonly config: ProviderConfig;

  constructor(options: ProviderOptions = {}) {
    this.config = (options.config ?? {}) as ProviderConfig;
  }

  id(): string {
    return this.label || "code-reviewer";
  }

  async callApi(
    _prompt: string,
    context?: { vars?: Record<string, unknown> },
  ): Promise<ProviderResponse> {
    const vars = context?.vars ?? {};

    try {
      const reviewer = this.config.mock
        ? createCodeReviewer({ model: mockModel(), workspaceRoot: fixtureRoot })
        : createCodeReviewer({
            model: this.config.model,
            promptVariant: this.config.promptVariant,
            workspaceRoot: fixtureRoot,
            temperature: 0,
            maxSteps: this.config.maxSteps,
          });

      const target = diffTarget(
        String(vars.title ?? "Untitled change"),
        String(vars.diff ?? ""),
        vars.description === undefined ? undefined : String(vars.description),
      );

      const review = await reviewer.review(target);

      return {
        output: JSON.stringify(review),
        metadata: {
          verdict: computeVerdict(review.criteria),
          findingCount: review.findings.length,
        },
      };
    } catch (error) {
      return {
        error: `code-reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
