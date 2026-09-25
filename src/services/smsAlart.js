const { sendMessage } = require("./smsGateway");

async function sendSOSAlert(aiSummary, location, contacts, options = {}) {
  const results = [];
  for (const contact of contacts) {
    let result;
    try {
      const reference = options.reference ? `\nSOS reference: ${options.reference}. Contact the person directly; replies to this SMS are not supported.` : "";
      let link;
      try { link = await options.responseLink?.(contact); }
      catch { console.error('Contact response link unavailable; initial SMS will still be sent'); }
      const response = await sendMessage({
        to: `+91${contact.contactNumber}`,
        body: `SOS!\n${aiSummary}\nLocation: ${location}${reference}${link ? `\nRespond securely (coming / cannot help): ${link}\nKeep this link private.` : ''}`,
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
