const router = require("express").Router();
const { createDemoService } = require("./service");
const models = require("./models");
const Contact = require("../models/contact");
const { sendMessage } = require("../services/smsGateway");
async function sendLiveDemoSms(owner, { kind, location }) {
  if (process.env.ENABLE_DEMO_SMS !== "true")
    throw Object.assign(
      new Error("Live demo SMS is disabled on this backend"),
      { status: 403 },
    );
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_PHONE_NUMBER
  )
    throw Object.assign(
      new Error("Twilio is not configured for live demo SMS"),
      { status: 503 },
    );
  const contacts = await Contact.find({
    profileId: owner,
    isActive: true,
    via: "SMS",
  }).lean();
  if (!contacts.length)
    throw Object.assign(
      new Error(
        "Add an active SMS trusted contact before enabling live demo SMS",
      ),
      { status: 409 },
    );
  const results = [];
  const latitude = Number(location.latitude).toFixed(5);
  const longitude = Number(location.longitude).toFixed(5);
  for (const contact of contacts) {
    try {
      const response = await sendMessage({
        to: `+91${contact.contactNumber}`,
        body: `SURAKSHA DEMO - NO EMERGENCY. Test ${kind === "journey" ? "journey" : "rescue"} SOS. Location: https://maps.google.com/?q=${latitude},${longitude} No action needed.`,
      });
      results.push(
        ["failed", "undelivered", "canceled"].includes(response.status)
          ? "failed"
          : "accepted",
      );
    } catch {
      results.push("failed");
    }
  }
  return {
    attempted: results.length,
    accepted: results.filter((value) => value === "accepted").length,
    failed: results.filter((value) => value === "failed").length,
  };
}
const service = createDemoService(
  models,
  (event) => require("../coordination/runtime").notify(event),
  sendLiveDemoSms,
);
// Gate before authentication so a disabled deployment exposes no demo API.
router.use((req, res, next) =>
  process.env.ENABLE_DEMO_MODE === "true"
    ? next()
    : res.status(404).json({ error: "Not found" }),
);
router.use(require("../middleware/userMiddleware"));
router.use(
  require("./rateLimit").createDemoRateLimit(require("../config/redis")),
);
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    res
      .status(e.status || (e.code === 11000 ? 409 : 500))
      .json({
        error: e.status
          ? e.message
          : "Demo operation failed; refresh and retry",
      });
  }
};
router.get(
  "/config",
  handle(async () => ({
    enabled: true,
    demoVersion: 2,
    checkInSeconds: 10,
    liveSmsAvailable:
      process.env.ENABLE_DEMO_SMS === "true" &&
      Boolean(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_PHONE_NUMBER,
      ),
  })),
);
router.post(
  "/sessions",
  handle(async (req) => {
    const run = await service.create(req.user._id);
    return service.snapshot(run._id, req.user._id);
  }),
);
router.get(
  "/sessions/:id",
  handle((req) => service.snapshot(req.params.id, req.user._id)),
);
for (const action of ["victim-location", "responder-location", "reset"]) {
  router.post(
    `/sessions/:id/${action}`,
    handle((req) => service.act(req.params.id, req.user._id, action, req.body)),
  );
}
router.post(
  "/sessions/:id/scenario",
  handle((req) =>
    service.act(req.params.id, req.user._id, req.body?.action, req.body),
  ),
);
module.exports = router;
