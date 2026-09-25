const mongoose = require('mongoose');

// One durable claim per journey. Never replay an uncertain provider submission.
function createJourneySos({ Journey, Contact, sessions, sendSOSAlert, notify = async () => {}, now = Date.now }) {
  return async function escalate(id, profileId) {
    await Journey.updateOne({ _id: id, profileId, sosState: 'sending', sosDeadline: { $lte: new Date(now()) } }, {
      $set: { sosState: 'unknown', sosError: 'SOS processing was interrupted. Check Safety agent for message status.' },
      $inc: { version: 1 },
    });
    const contacts = await Contact.find({ profileId, isActive: true });
    const sessionId = new mongoose.Types.ObjectId();
    const journey = await Journey.findOneAndUpdate({
      _id: id, profileId, open: true, autoSosEnabled: true,
      checkInState: 'unanswered', checkInDueAt: { $lte: new Date(now()) }, sosState: 'none',
    }, {
      $set: { sosState: 'sending', sosSessionId: sessionId, sosStartedAt: new Date(now()),
        sosDeadline: new Date(now() + contacts.length * 30000 + 120000) },
      $inc: { version: 1 },
    }, { returnDocument: 'after' }).lean();
    if (!journey) return;
    let submitting = false;
    let state = 'failed', error;
    try {
      const point = journey.currentLocation;
      const mapsLink = `https://maps.google.com/?q=${point.latitude},${point.longitude}`;
      const observed = new Date(point.observedAt).toISOString();
      const summary = `Automatic safety alert: a journey safety check went unanswered. Safety is unconfirmed. Please contact this person. Last known GPS location recorded ${observed}; it may be outdated.`;
      const session = await sessions.createSession(profileId, { summary, severity: 'High' }, mapsLink, contacts, { point, sessionId });
      const attempt = contact => session.attempts.find(a => String(a.contactId) === String(contact._id));
      submitting = true;
      const results = await sendSOSAlert(summary, mapsLink, contacts, {
        reference: session.reference,
        responseLink: contact => sessions.issueContactLink(session._id, contact._id),
        statusCallback: contact => sessions.callbackUrl(session._id, attempt(contact)._id),
        onResult: (contact, result) => sessions.recordAttempt(session._id, attempt(contact)._id, {
          ...result, status: result.deliveryStatus || (result.status === 'sent' ? 'accepted' : 'failed'),
        }),
      });
      const accepted = results.filter(r => r.status === 'sent').length;
      state = !contacts.length ? 'no_contacts' : accepted === contacts.length ? 'accepted' : accepted ? 'partial'
        : results.some(r => r.deliveryStatus === 'unknown') ? 'unknown' : 'failed';
      await sessions.finishInitial(session._id);
    } catch (e) {
      state = submitting ? 'unknown' : 'failed';
      error = submitting ? 'SMS submission could not be confirmed. Check Safety agent.' : 'Automatic SOS could not be started. Use Emergency SOS or contact help directly.';
      console.error('Journey SOS processing failed:', e.name);
    }
    await Journey.updateOne({ _id: id, profileId, sosState: 'sending' }, {
      $set: { sosState: state, ...(error ? { sosError: error } : {}) }, $inc: { version: 1 },
    });
    try { await notify({ profileId: String(profileId), journeyId: String(id), sessionId: String(sessionId), type: 'journey-updated' }); }
    catch { /* Owner polling recovers missed notifications. */ }
  };
}
module.exports = { createJourneySos };
