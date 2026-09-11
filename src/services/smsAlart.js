const { sendMessage } = require("./smsGateway");

async function sendSOSAlert(aiSummary, location, contacts, options = {}) {
  const results = [];
  for (const contact of contacts) {
    let result;
    try {
      const reference = options.reference ? `\nReply ACK ${options.reference} to acknowledge, or include ${options.reference} in your reply.` : "";
      const response = await sendMessage({
        to: `+91${contact.contactNumber}`,
        body: `SOS!\n${aiSummary}\nLocation: ${location}${reference}`,
        statusCallback: options.statusCallback?.(contact),
      });
      result = { contact: contact.contacts, number: contact.contactNumber, status: ["failed", "undelivered", "canceled"].includes(response.status) ? "failed" : "sent", sid: response.sid };
    } catch (error) {
      result = { contact: contact.contacts, number: contact.contactNumber, status: "failed", deliveryStatus: error.status >= 400 && error.status < 500 ? "failed" : "unknown", error: "SMS submission failed" };
      console.error("Initial SOS SMS failed:", error.code || error.name);
    }
    results.push(result);
    // Tracking failure must never stop alerts to the remaining contacts.
    try { await options.onResult?.(contact, result); }
    catch (error) { console.error("SOS tracking update failed:", error.name); }
  }
  return results;
}
module.exports = { sendSOSAlert };
