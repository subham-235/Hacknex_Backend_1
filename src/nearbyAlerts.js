// Short reconnect buffer for this API process; not a durable incident inbox.
function createNearbyAlerts({ now = Date.now, ttlMs = 10 * 60 * 1000, maxUsers = 1000 } = {}) {
  const recipients = new Map();
  let sequence = 0;
  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, alerts] of recipients) {
      const fresh = alerts.filter(alert => alert.timestamp > cutoff);
      if (fresh.length) recipients.set(id, fresh);
      else recipients.delete(id);
    }
  }
  return {
    add(profileId, payload) {
      prune();
      const key = String(profileId);
      const timestamp = now();
      const alert = { ...payload, id: `${timestamp}-${++sequence}`, timestamp };
      recipients.set(key, [...(recipients.get(key) || []), alert].slice(-10));
      while (recipients.size > maxUsers) recipients.delete(recipients.keys().next().value);
      return alert;
    },
    list(profileId) { prune(); return recipients.get(String(profileId)) || []; },
  };
}
module.exports = { createNearbyAlerts };
