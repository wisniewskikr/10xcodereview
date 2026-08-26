## Overall concept

- GHA workflow run for ecery new pull request to master
- composite action for the review itself so that main workflow is easy to reason about

## Input parameters

- pull request title
- pull request description (?? cost tradeoff)
- git diff

## Code Review Criteria

Each criterion is graded **1-10**. Think of it as a school grade: 1 = "this hurts", 10 = "nothing to add".

| # | Criterion | What it asks | 1/10 — bad side | 10/10 — good side |
|---|---|---|---|---|
| 1 | Implementation correctness | Does the code really do what the PR promises, also in odd cases? | Wrong results, obvious bugs, edge cases ignored | Does exactly what it promises, edge cases handled |
| 2 | Idiomaticity | Does the code look like the rest of the project and like normal code in this language? | Foreign style, fights the language and the codebase | Blends in - reads like it was always there |
| 3 | Complexity | Is the code as simple as the problem allows? | A maze: deep nesting, huge functions, hidden tricks | A straight road: small, flat, easy to follow |
| 4 | Test / risk coverage | Are the risky parts protected by tests? | No seatbelt where the car goes fastest | Risky paths covered with meaningful tests |
| 5 | Documentation | Can the next person understand the change without asking the author? | Cryptic names, no comments, stale docs | Clear names, comments where needed, docs updated |
| 6 | Security and safety | Does the change keep doors locked and data intact? | Leaked secrets, injection holes, destructive operations | Inputs validated, secrets safe, no destructive surprises |

## Parked for later
- business alignment (require broader context)
- architectural fit (require broader context)

## Expected side-effects

- PR comment with summary
- labels ai-cr:failed (red), ad-cr:passed (green) or ai-cr:review (gray)

## Expected behavior

- on-demand retry when label ai-r:review is added