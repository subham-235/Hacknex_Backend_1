const { getGeoConfig } = require("./config");
const geo = require("./geo");
const OPEN = ["active", "acknowledged", "review_required"];
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const isOpen = (s, now) => s && OPEN.includes(s.status) && +new Date(s.expiresAt) > now;
function createResponderService({
  Session,
  ActiveUser,
  notify = async () => {},
  now = Date.now,
  config = getGeoConfig(),
}) {
  const eligible = async (id, owner) => {
    if (String(id) === String(owner)) return null;
    const user = await ActiveUser.findOne({
      profileId: id,
      isActive: true,
      expireAt: { $gt: new Date(now()) },
      lastSeen: { $gte: new Date(now() - config.staleMs) },
    }).lean();
    const c = user?.location?.coordinates;
    const location = c && {
      longitude: c[0],
      latitude: c[1],
      accuracy: user.accuracy,
      observedAt: user.locationObservedAt || user.lastSeen,
      receivedAt: user.lastSeen,
    };
    return geo.validPoint(location) && now() - +new Date(location.observedAt) <= config.staleMs
      ? location
      : null;
  };
  // All responder/geo changes share a revision. A concurrent resolution is also
  // excluded by the status + expiry filter, even if it does not bump revision.
  async function mutate(id, change) {
    for (let retry = 0; retry < 8; retry++) {
      const s = await Session.findById(id).lean();
      if (!s) fail("Session not found", 404);
      if (!isOpen(s, now())) fail("Emergency is closed");
      const events = [];
      const patch = await change(s, events);
      if (!patch) return s;
      const updated = await Session.findOneAndUpdate(
        {
          _id: id,
          status: { $in: OPEN },
          expiresAt: { $gt: new Date(now()) },
          ...(s.coordinationVersion === undefined
            ? { coordinationVersion: { $exists: false } }
            : { coordinationVersion: s.coordinationVersion }),
        },
        { $set: patch, $inc: { coordinationVersion: 1 } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) continue;
      // Socket delivery is best effort; the persisted request inbox is authoritative.
      for (const e of events) {
        try {
          await notify(e);
        } catch {
          /* recovered by API polling */
        }
      }
      return updated;
    }
    fail("Concurrent update; retry");
  }
  function event(s, events, type, profileId = s.profileId) {
    events.push({ profileId: String(profileId), sessionId: String(s._id), type });
  }
  async function assign(s, requests) {
    if (s.activeResponder) return s.activeResponder;
    const center = geo.getCurrentEmergencyCenter(s, now(), config);
    if (!center) return null;
    const choices = [];
    for (const r of requests.filter((r) => r.status === "accepted")) {
      const location = await eligible(r.responderUserId, s.profileId);
      if (!location || geo.distance(center, location) > config.radii.at(-1)) continue;
      const busy = await Session.exists({
        _id: { $ne: s._id },
        "activeResponder.userId": r.responderUserId,
      });
      if (!busy) choices.push({ r, location, distance: geo.distance(center, location) });
    }
    choices.sort(
      (a, b) =>
        a.distance - b.distance ||
        String(a.r.responderUserId).localeCompare(String(b.r.responderUserId)),
    );
    const best = choices[0];
    return best
      ? {
          userId: best.r.responderUserId,
          acceptedAt: best.r.respondedAt,
          assignedAt: new Date(now()),
          currentStatus: "assigned",
          lastLocation: best.location,
        }
      : null;
  }
  async function respond(id, userId, decision) {
    return mutate(id, async (s, events) => {
      const requests = s.nearbyResponderRequests || [];
      const request = requests.find((r) => String(r.responderUserId) === String(userId));
      if (!request) fail("Request not found", 404);
      if (request.status !== "pending" || +new Date(request.expiresAt) <= now())
        fail("Request already answered or expired");
      const location = await eligible(userId, s.profileId);
      const center = geo.getCurrentEmergencyCenter(s, now(), config);
      if (!location || !center || geo.distance(center, location) > config.radii.at(-1))
        fail("Responder is no longer eligible", 403);
      request.status = decision;
      request.respondedAt = new Date(now());
      const activeResponder = await assign(s, requests);
      event(s, events, decision === "accepted" ? "responder-accepted" : "responder-declined");
      event(s, events, "agent-session-updated", userId);
      if (!s.activeResponder && activeResponder) {
        event(s, events, "responder-assigned");
        event(s, events, "responder-assigned", activeResponder.userId);
      }
      return {
        nearbyResponderRequests: requests,
        activeResponder,
        escalationState: activeResponder ? "help_confirmed" : "searching",
        coordinationNextRunAt: new Date(now()),
      };
    });
  }
  async function location(id, userId, body, victim = false) {
    const point = geo.locationInput(body, now(), config);
    const result = await mutate(id, async (s, events) => {
      if (
        victim
          ? String(s.profileId) !== String(userId)
          : String(s.activeResponder?.userId) !== String(userId)
      )
        fail("Not authorized", 403);
      if (!victim && ["completed", "cancelled"].includes(s.activeResponder.currentStatus))
        fail("Responder tracking has ended");
      const previous = victim ? s.latestVictimLocation : s.activeResponder.lastLocation;
      geo.acceptLocation(previous, point, config);
      const next = {
        ...s,
        ...(victim
          ? { latestVictimLocation: point }
          : { activeResponder: { ...s.activeResponder, lastLocation: point } }),
      };
      const track = geo.tracking(
        geo.getCurrentEmergencyCenter(next, now(), config),
        next.activeResponder?.lastLocation,
        now(),
        config,
      );
      if (track?.zone === "arrival_candidate" && !next.activeResponder.arrivalCandidateAt)
        next.activeResponder.arrivalCandidateAt = new Date(now());
      if (
        track?.zone === "nearby" &&
        ["assigned", "en_route"].includes(next.activeResponder.currentStatus)
      )
        next.activeResponder.currentStatus = "nearby";
      event(s, events, "responder-location-updated");
      if (next.activeResponder)
        event(s, events, "responder-location-updated", next.activeResponder.userId);
      if (
        track?.zone !== s.responderTracking?.zone &&
        ["nearby", "arrival_candidate"].includes(track?.zone)
      )
        event(
          s,
          events,
          track.zone === "nearby" ? "responder-nearby" : "responder-arrival-candidate",
        );
      return {
        ...(victim ? { latestVictimLocation: point } : {}),
        activeResponder: next.activeResponder,
        responderTracking: track,
        coordinationNextRunAt: new Date(now()),
      };
    });
    if (!victim && ActiveUser.updateOne) {
      // Refresh existing community opt-in, never reactivate a user implicitly.
      try {
        await ActiveUser.updateOne(
          {
            profileId: userId,
            isActive: true,
            lastSeen: { $lt: point.receivedAt },
            $or: [
              { locationObservedAt: { $lt: point.observedAt } },
              { locationObservedAt: { $exists: false } },
            ],
          },
          {
            $set: {
              lastSeen: point.receivedAt,
              locationObservedAt: point.observedAt,
              accuracy: point.accuracy,
              location: { type: "Point", coordinates: [point.longitude, point.latitude] },
              expireAt: new Date(now() + 600000),
            },
          },
        );
      } catch {
        /* Tracking is already durable on the session. */
      }
    }
    return result;
  }
  async function state(id, userId, status) {
    if (!["en_route", "arrived", "completed", "cancelled"].includes(status))
      fail("Invalid responder state", 400);
    return mutate(id, async (s, events) => {
      const a = s.activeResponder;
      if (String(a?.userId) !== String(userId)) fail("Not assigned to this incident", 403);
      const transitions = {
        assigned: ["en_route", "arrived", "cancelled"],
        en_route: ["arrived", "cancelled"],
        nearby: ["en_route", "arrived", "cancelled"],
        arrived: ["completed", "cancelled"],
        completed: [],
      };
      if (a.currentStatus === status) return null;
      if (!transitions[a.currentStatus]?.includes(status)) fail("Invalid responder transition");
      const requests = s.nearbyResponderRequests;
      if (status === "cancelled")
        requests.find((r) => String(r.responderUserId) === String(userId)).status = "cancelled";
      event(s, events, status === "arrived" ? "responder-arrived" : "agent-session-updated");
      event(s, events, "agent-session-updated", userId);
      return {
        activeResponder: status === "cancelled" ? null : { ...a, currentStatus: status },
        nearbyResponderRequests: requests,
        responderTracking: status === "cancelled" ? null : s.responderTracking,
        responderHistory: [
          ...(s.responderHistory || []),
          { userId, status, at: new Date(now()) },
        ].slice(-50),
        escalationState: status === "cancelled" ? "searching" : s.escalationState,
        coordinationNextRunAt: new Date(now()),
      };
    });
  }
  async function check(id) {
    return mutate(id, async (s, events) => {
      const presence = await eligible(s.profileId, null);
      if (
        presence &&
        +new Date(presence.observedAt) > +new Date(s.latestVictimLocation?.observedAt || 0)
      )
        s.latestVictimLocation = presence;
      const at = now(),
        center = geo.getCurrentEmergencyCenter(s, at, config);
      const requests = s.nearbyResponderRequests || [];
      for (const r of requests)
        if (r.status === "pending" && +new Date(r.expiresAt) <= at) r.status = "expired";
      let activeResponder = s.activeResponder;
      const risks = [];
      if (!center?.fresh) risks.push("LOCATION_STALE");
      // Stale assignments lose precise-location authorization and reopen search.
      if (
        activeResponder &&
        activeResponder.currentStatus !== "completed" &&
        (at - +new Date(activeResponder.lastLocation?.observedAt || activeResponder.assignedAt) >
          config.staleMs ||
          !(await ActiveUser.exists({ profileId: activeResponder.userId, isActive: true })))
      ) {
        risks.push("RESPONDER_LOCATION_STALE");
        const r = requests.find(
          (r) => String(r.responderUserId) === String(activeResponder.userId),
        );
        if (r) r.status = "cancelled";
        event(s, events, "agent-session-updated", activeResponder.userId);
        s.responderHistory = [
          ...(s.responderHistory || []),
          { userId: activeResponder.userId, status: "cancelled", at: new Date(at) },
        ].slice(-50);
        activeResponder = null;
      }
      activeResponder = await assign({ ...s, activeResponder }, requests);
      if (activeResponder && String(s.activeResponder?.userId) !== String(activeResponder.userId)) {
        event(s, events, "responder-assigned");
        event(s, events, "responder-assigned", activeResponder.userId);
      }
      let stage = s.escalationStage || 0;
      const history = s.escalationHistory || [];
      const lastStageAt = +new Date(history.at(-1)?.at || 0);
      const expand =
        !activeResponder &&
        (stage === 0 || at - lastStageAt >= config.acceptMs) &&
        stage < config.radii.length;
      if (expand) {
        stage++;
        history.push({ stage, radiusMeters: config.radii[stage - 1], at: new Date(at) });
        event(s, events, "emergency-radius-expanded");
      }
      const previousCenter = s.emergencyGeofence?.searchCenter || s.emergencyGeofence?.center;
      const moved =
        center && previousCenter && geo.distance(center, previousCenter) >= config.movement;
      if (moved) risks.push("VICTIM_MOVING_DURING_EMERGENCY");
      const refresh =
        !s.emergencyGeofence?.lastQueriedAt ||
        expand ||
        (moved && at - +new Date(s.emergencyGeofence.lastQueriedAt) >= config.recalcMs);
      let fence = s.emergencyGeofence;
      // The persisted circle always follows the current victim. Discovery can
      // remain throttled independently by lastQueriedAt and movement thresholds.
      if (center && fence) fence = { ...fence, center };
      if (center && refresh) {
        const radius = config.radii[Math.max(0, stage - 1)];
        if (!activeResponder) {
          const users = await ActiveUser.find({
            profileId: { $nin: [s.profileId, ...requests.map((r) => r.responderUserId)] },
            isActive: true,
            expireAt: { $gt: new Date(at) },
            lastSeen: { $gte: new Date(at - config.staleMs) },
            location: {
              $near: {
                $geometry: { type: "Point", coordinates: [center.longitude, center.latitude] },
                $maxDistance: radius,
              },
            },
          })
            .limit(config.maxRequests)
            .lean();
          for (const user of users) {
            if (requests.length >= config.maxRequests) break;
            if (requests.some((r) => String(r.responderUserId) === String(user.profileId)))
              continue;
            const c = user.location.coordinates;
            requests.push({
              responderUserId: user.profileId,
              status: "pending",
              distanceAtNotification:
                Math.ceil(geo.distance(center, { longitude: c[0], latitude: c[1] }) / 100) * 100,
              notifiedAt: new Date(at),
              expiresAt: new Date(Math.min(+new Date(s.expiresAt), at + config.acceptMs)),
            });
            event(s, events, "responder-request-created", user.profileId);
          }
        }
        fence = { center, searchCenter: center, radiusMeters: radius, lastQueriedAt: new Date(at) };
      }
      if (!activeResponder) risks.push("NO_RESPONDER_ACCEPTED");
      const track = geo.tracking(center, activeResponder?.lastLocation, at, config);
      if (track?.zone === "approaching") risks.push("RESPONDER_APPROACHING");
      event(s, events, "agent-session-updated");
      return {
        latestVictimLocation: s.latestVictimLocation,
        nearbyResponderRequests: requests,
        activeResponder,
        responderHistory: s.responderHistory || [],
        responderTracking: track,
        escalationStage: stage,
        escalationHistory: history,
        escalationState: activeResponder
          ? "help_confirmed"
          : stage >= config.radii.length &&
              at - +new Date(history.at(-1)?.at || 0) >= config.acceptMs
            ? "help_unavailable"
            : "searching",
        emergencyGeofence: fence,
        geoRiskSignals: risks,
        geoEvents: [
          ...(s.geoEvents || []),
          ...risks
            .filter((r) => !s.geoRiskSignals?.includes(r))
            .map((type) => ({ type, at: new Date(at) })),
        ].slice(-50),
        coordinationNextRunAt: new Date(at + Math.min(config.acceptMs, config.recalcMs, 15000)),
      };
    });
  }
  function view(s, userId) {
    const request = s.nearbyResponderRequests?.find(
      (r) => String(r.responderUserId) === String(userId),
    );
    const assigned =
      isOpen(s, now()) &&
      String(s.activeResponder?.userId) === String(userId) &&
      now() -
        +new Date(s.activeResponder.lastLocation?.observedAt || s.activeResponder.assignedAt) <=
        config.staleMs;
    if (!request && !assigned) fail("Request not found", 404);
    return {
      sessionId: s._id,
      status: isOpen(s, now()) ? s.status : "closed",
      request: request && {
        status: isOpen(s, now())
          ? request.status === "pending" && +new Date(request.expiresAt) <= now()
            ? "expired"
            : request.status
          : "cancelled",
        distanceAtNotification: request.distanceAtNotification,
        expiresAt: request.expiresAt,
      },
      assigned,
      ...(assigned
        ? {
            responder: { currentStatus: s.activeResponder.currentStatus },
            ...(s.activeResponder.currentStatus === "completed"
              ? {}
              : {
                  victimLocation: geo.getCurrentEmergencyCenter(s, now(), config),
                  tracking: geo.tracking(
                    geo.getCurrentEmergencyCenter(s, now(), config),
                    s.activeResponder.lastLocation,
                    now(),
                    config,
                  ),
                }),
          }
        : {}),
    };
  }
  return { respond, location, state, check, view };
}
module.exports = { createResponderService, OPEN, isOpen };
