# Fixture: `react19-migration`

A "rather complex" pull request that migrates `UserActivityFeed` from a React 16
class component to React 19 function-component hooks. The migration work itself
is mostly correct - `this.state` → `useState`, lifecycle methods → `useEffect`,
`PropTypes` → a TypeScript props interface, `ReactDOM.render` → `createRoot`, a
React 16 → 19 dependency bump, and the addition of `<StrictMode>` in
`src/index.tsx`.

Embedded in that otherwise-plausible change are **three correctness bugs**, all
in `src/components/UserActivityFeed.tsx`. Each is a real regression against the
class version, each changes runtime behaviour (not style), and each is visible
from the diff alone. Two of them are materially worse under React 19's default
automatic batching and StrictMode double-invoke.

The golden list is `expected-flaws.json`; the ids below match its `id` fields.

## Files

| Path | Role |
| --- | --- |
| `change.diff` | the PR under review - the only input the reviewer is given |
| `src/components/UserActivityFeed.tsx` | post-migration component; the diff's post-image, on disk so the agent's `readFile` works |
| `src/lib/activity-stream.ts` | correct stub - `subscribe` returns an unsubscribe fn |
| `src/lib/api.ts` | correct stub - `markRead`, `persistLastSeen` |
| `expected-flaws.json` | machine-readable golden flaw list |

All diff paths are under `src/` (or the app-root `package.json`); none under
`packages/`, because `diffTarget` runs `excludeDirectoryFromDiff(diff, "packages")`
and would otherwise strip the hunks before the model sees them.

## Flaw 1 — `stale-closure-unread`

**Before.** `markOneRead` did `this.setState(prev => ({ unread: prev.unread - 1 }))`
- a functional update, correct even if other `setState`s interleave.

**After.** `markOneRead` does `setUnread(unread - 1)` *after* `await api.markRead(...)`.
`unread` is captured from the render that created the handler. While the request
is in flight the stream subscription runs `setUnread(prev => prev + 1)` for every
event that arrives. When the handler resumes it writes `capturedUnread - 1`,
discarding those increments.

**In practice.** The unread badge under-counts, drifts, and can show negative
numbers after a burst of activity during a "mark read" tap.

**Why React 19 makes it worse.** React 19 batches state updates inside promise
continuations, `setTimeout`, and native event handlers - not just React events.
The post-`await` `setUnread` is now batched together with the concurrent
increments from the subscription, so the stale-base overwrite that was a narrow
race in React 17 is the normal result in React 19.

**Fix.** `setUnread(prev => prev - 1)` (and rethink `markAllRead`, which has the
same stale-base shape with `setUnread(0)`).

## Flaw 2 — `missing-effect-cleanup`

**Before.** The class subscribed in `componentDidMount`, unsubscribed in
`componentWillUnmount`, and on every `userId` change unsubscribed then
re-subscribed in `componentDidUpdate`.

**After.** The effect calls `const unsubscribe = activityStream.subscribe(userId, cb)`
and then returns nothing. The disposer is dropped on the floor.

**In practice.** Every `userId` change adds another live listener; none are ever
removed. Callbacks fire `setEvents` / `setUnread` on unmounted trees, memory and
event volume grow without bound, and the unread count multiplies.

**Why React 19 makes it worse.** StrictMode (added in this same PR) mounts the
component, runs the effect, runs cleanup, then runs the effect again. With no
cleanup, the first mount alone leaves **two** live subscriptions, so the feed
double-counts every event from the start in development.

**Fix.** `return () => unsubscribe();` at the end of the effect.

## Flaw 3 — `stale-effect-deps`

**Before.** `componentDidUpdate(prevProps, prevState)` compared the newest event
id against the previous newest and called `api.persistLastSeen` whenever it
changed - i.e. on every new event.

**After.** A second `useEffect` calls `api.persistLastSeen(userId, events[0].id)`
but its dependency array is `[userId]`, omitting `events`. It runs once when
`userId` is set - when `events` is still `[]`, so it early-returns - and never
runs again.

**In practice.** The server-side "last seen" marker never advances. A user who
reads their feed on one device still sees everything as unread on another.

**Why React 19 makes it worse.** Mechanism is version-independent, but React 19
makes `react-hooks/exhaustive-deps` the default lint guidance and StrictMode's
effect re-run makes the "runs once, then frozen" behaviour trivial to catch in a
test.

**Fix.** Add `events` to the dependency array (and read `events[0]?.id`).
