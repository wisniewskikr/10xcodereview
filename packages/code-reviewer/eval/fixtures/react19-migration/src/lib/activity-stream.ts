/**
 * In-memory activity stream. A real app would back this with a WebSocket or
 * SSE connection; the shape is all the component (and the reviewer) needs.
 */

export interface ActivityEvent {
  id: string;
  kind: string;
  at: string;
}

type Listener = (evt: ActivityEvent) => void;

class ActivityStream {
  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * Register `cb` for a user's events. Returns an unsubscribe function - call
   * it from a `useEffect` cleanup so a re-subscription (new `userId`, StrictMode
   * remount) does not leave the old listener attached.
   */
  subscribe(userId: string, cb: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    set.add(cb);
    this.listeners.set(userId, set);

    return () => {
      set.delete(cb);
      if (set.size === 0) {
        this.listeners.delete(userId);
      }
    };
  }

  /** Push an event to every current subscriber for `userId`. */
  emit(userId: string, evt: ActivityEvent): void {
    for (const cb of this.listeners.get(userId) ?? []) {
      cb(evt);
    }
  }

  /** Number of live listeners for `userId` - used by tests to catch leaks. */
  listenerCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}

export const activityStream = new ActivityStream();
