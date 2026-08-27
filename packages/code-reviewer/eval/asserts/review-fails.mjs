import { computeVerdict } from "../../dist/agent/verdict.js";

/**
 * Deterministic "the review actually fails" gate - no model in the loop.
 *
 * Passes when the review's six criteria compute a `failed` verdict AND it
 * carries at least three findings. Imports the COMPILED verdict function, so
 * `npm run eval` must `npm run build` first (it does).
 *
 * @param {string} output - the provider's output (a JSON-stringified CodeReview)
 * @returns {{ pass: boolean, score: number, reason: string, namedScores: Record<string, number> }}
 */
export default function reviewFails(output) {
  const fail = (reason) => ({ pass: false, score: 0, reason, namedScores: { review_fails: 0 } });

  if (typeof output !== "string" || output.trim() === "") {
    return fail("no output from the reviewer (it errored or returned nothing)");
  }

  let review;
  try {
    review = JSON.parse(output);
  } catch {
    return fail("provider output was not JSON");
  }

  if (review === null || typeof review !== "object" || typeof review.criteria !== "object") {
    return fail("parsed output has no `criteria` object");
  }

  const verdict = computeVerdict(review.criteria);
  const findingCount = Array.isArray(review.findings) ? review.findings.length : 0;

  const verdictFailed = verdict === "failed";
  const enoughFindings = findingCount >= 3;
  const pass = verdictFailed && enoughFindings;

  const reason = pass
    ? `verdict=failed with ${findingCount} findings`
    : [
        !verdictFailed ? `verdict was "${verdict}", expected "failed"` : null,
        !enoughFindings ? `only ${findingCount} finding(s), expected >= 3` : null,
      ]
        .filter(Boolean)
        .join("; ");

  return { pass, score: pass ? 1 : 0, reason, namedScores: { review_fails: pass ? 1 : 0 } };
}
