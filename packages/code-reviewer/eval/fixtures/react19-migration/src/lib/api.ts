/**
 * Thin REST client for the activity endpoints. Correct as written - the flaws
 * in this fixture are all in how `UserActivityFeed` calls these, not here.
 */

async function send(path: string, method: "POST" | "PUT", body: unknown): Promise<void> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status}`);
  }
}

export const api = {
  /** Mark one event (or, with no `eventId`, the whole feed) as read. */
  markRead(userId: string, eventId?: string): Promise<void> {
    return send(`/api/users/${userId}/activity/read`, "POST", { eventId: eventId ?? null });
  },

  /** Persist the newest event the user has seen so other devices can catch up. */
  persistLastSeen(userId: string, eventId: string): Promise<void> {
    return send(`/api/users/${userId}/activity/last-seen`, "PUT", { eventId });
  },
};
