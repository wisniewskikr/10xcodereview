import { useEffect, useState } from "react";
import { activityStream, type ActivityEvent } from "../lib/activity-stream";
import { api } from "../lib/api";

interface UserActivityFeedProps {
  userId: string;
}

/**
 * Live feed of a user's activity, migrated from the React 16 class component
 * `UserActivityFeed` (see git history). Same behaviour: subscribe to the
 * stream, keep an unread counter, let the user mark items read.
 */
export function UserActivityFeed({ userId }: UserActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const unsubscribe = activityStream.subscribe(userId, (evt) => {
      setEvents((prev) => [evt, ...prev]);
      setUnread((prev) => prev + 1);
    });

    // The class version did this teardown in componentWillUnmount and on every
    // prop change in componentDidUpdate. Here the unsubscribe handle is created
    // and then dropped: nothing is returned from the effect, so React never
    // tears the old subscription down. Every `userId` change stacks another
    // live listener, and under React 19 StrictMode the mount runs twice, so the
    // feed starts life with two subscriptions and double-counts every event.
  }, [userId]);

  useEffect(() => {
    if (events.length === 0) {
      return;
    }

    // Tell the server how far this user has read so their other devices catch
    // up. This reads `events[0]`, but the dependency array only lists `userId`,
    // so after the first non-empty render it never runs again - the server's
    // "last seen" marker freezes on whatever was newest when the feed loaded.
    void api.persistLastSeen(userId, events[0].id);
  }, [userId]);

  async function markOneRead(eventId: string) {
    await api.markRead(userId, eventId);

    // `unread` is the value captured when this handler was created. While the
    // request was in flight the stream subscription may have run
    // `setUnread(prev => prev + 1)` several times; React 19 batches this write
    // in with those, and because it is computed from the stale base rather than
    // an updater, every increment that arrived during the await is wiped out.
    setUnread(unread - 1);
  }

  async function markAllRead() {
    await api.markRead(userId);

    // Same stale-base problem: any events that streamed in during the request
    // are zeroed here even though the user never saw them.
    setUnread(0);
  }

  return (
    <section className="user-activity-feed">
      <header className="user-activity-feed__header">
        <h2>Activity</h2>
        <span className="user-activity-feed__badge" data-testid="unread-count">
          {unread} unread
        </span>
        <button type="button" onClick={markAllRead} disabled={unread === 0}>
          Mark all read
        </button>
      </header>

      {events.length === 0 ? (
        <p className="user-activity-feed__empty">No activity yet.</p>
      ) : (
        <ul className="user-activity-feed__list">
          {events.map((evt) => (
            <li key={evt.id} className={`user-activity-feed__item user-activity-feed__item--${evt.kind}`}>
              <time dateTime={evt.at}>{new Date(evt.at).toLocaleTimeString()}</time>
              <span className="user-activity-feed__kind">{evt.kind}</span>
              <button type="button" onClick={() => markOneRead(evt.id)}>
                Mark read
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
