const twilio = require("twilio");
let client;
async function sendMessage({ to, body, statusCallback }) {
  client ||= twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
    { timeout: 10000, autoRetry: false },
  );
  return client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
    ...(statusCallback ? { statusCallback } : {}),
  });
}
module.exports = { sendMessage };
