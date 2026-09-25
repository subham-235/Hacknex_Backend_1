const Session = require("../models/emergencySession");
const ActiveUser = require("../models/activeUser");
const Journey = require("../models/safetyJourney");
const { createResponderService } = require("./responders");
const { createJourneyService } = require("./journeys");
async function notify(event) {
  // API process emits locally. Worker uses the same authenticated-room relay.
  try {
    require("../socket")
      .getIO()
      .to(`user:${event.profileId}`)
      .emit(event.type, {
        sessionId: event.sessionId, journeyId: event.journeyId,
        ...(event.simulated ? { simulated: true, demoRunId: event.demoRunId } : {}),
      });
  } catch {
    await require("../config/redis").publish("suraksha-geo-updates", JSON.stringify(event));
  }
  if (event.type === "responder-request-created" && !event.simulated) {
    try {
      require("../socket").publishNearbyAlert(event.profileId, {
        sessionId: event.sessionId,
        message: "Someone nearby needs help!",
        distance: "Open responder requests for approximate distance",
      });
    } catch {
      /* worker relay emits this event */
    }
  }
}
const responders = createResponderService({ Session, ActiveUser, notify });
const journeys = createJourneyService({ Journey, notify });
module.exports = { responders, journeys, notify };
