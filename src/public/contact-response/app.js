/* No analytics, third-party scripts or persistent browser storage on this page. */
const token = location.hash.slice(1);
const base = location.pathname.replace(/\/$/, '');
const el = id => document.getElementById(id);
let state, closed = false, busy = false, sharing = false, watch, latest, timer, uploading = false;
let lastSent = 0, sharingGeneration = 0, refreshing = false;
async function api(action, body = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${base}/api/${action}`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 410) { closed = true; stopCapture(); render(); }
      throw new Error(data.error || 'Could not save your response.');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Connection timed out. Your update may not have reached the person. Please retry.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function render() {
  const status = state?.responseStatus;
  const helping = ['coming', 'arrived'].includes(status);
  el('coming').disabled = closed || busy || !state || status === 'coming';
  el('cannot').disabled = closed || busy || !state || status === 'cannot_help';
  el('arrived').hidden = !helping || closed;
  el('arrived').disabled = busy || status === 'arrived';
  el('location-section').hidden = !helping || closed;
  el('share').disabled = busy || closed;
  if (closed) {
    el('status').textContent = 'This link is no longer available. Contact the person directly if you still need to check on them.';
    return;
  }
  if (!state) return;
  el('reference').textContent = `SOS ${state.reference} · Link expires ${new Date(state.expiresAt).toLocaleTimeString()}`;
  el('status').textContent = {
    pending: 'Choose a response below. Opening the link does not send a response.',
    coming: 'Your response is saved: you’re coming to help.',
    cannot_help: 'Your response is saved: you cannot help. You can change it if your plans change.',
    arrived: 'Your arrival is recorded. The SOS stays open until the person marks themselves safe.',
  }[status];
  const point = state.victimLocation;
  el('directions').hidden = !point;
  if (point) el('directions').href = `https://maps.google.com/?q=${point.latitude},${point.longitude}`;
  el('victim-location-note').textContent = point
    ? point.fresh ? 'Recent location shared by the person.' : 'Last known location; it may be outdated.'
    : 'Waiting for their location.';
}
async function refresh() {
  if (closed || refreshing || busy) return;
  refreshing = true;
  try {
    state = await api('context');
    if (!['coming', 'arrived'].includes(state.responseStatus)) stopCapture();
    el('error').textContent = '';
    render();
  } catch (error) { el('error').textContent = error.message; }
  finally { refreshing = false; }
}
async function respond(status) {
  let saved = false;
  busy = true;
  render();
  el('error').textContent = '';
  try {
    const result = await api('respond', { status });
    state = { ...state, ...result };
    saved = true;
    if (status === 'cannot_help') stopCapture();
  } catch (error) { el('error').textContent = error.message; }
  finally { busy = false; render(); }
  if (saved) await refresh();
}
function stopCapture() {
  sharingGeneration++;
  sharing = false;
  if (watch !== undefined) navigator.geolocation?.clearWatch(watch);
  watch = undefined;
  clearInterval(timer);
  latest = null;
  el('share').textContent = 'Share my live location';
  el('location-status').textContent = 'Location sharing is off.';
}
async function upload() {
  if (!sharing || !latest || uploading || Date.now() - lastSent < 15000) return;
  const generation = sharingGeneration;
  uploading = true;
  lastSent = Date.now();
  try {
    await api('location', latest);
    if (sharing && generation === sharingGeneration) el('location-status').textContent = 'Live location shared. Keep this page open and your device awake.';
  } catch (error) {
    if (sharing && generation === sharingGeneration) el('location-status').textContent = `Location not updated: ${error.message}`;
  } finally { uploading = false; }
}
el('coming').addEventListener('click', () => void respond('coming'));
el('cannot').addEventListener('click', () => void respond('cannot_help'));
el('arrived').addEventListener('click', () => void respond('arrived'));
el('share').addEventListener('click', async () => {
  if (sharing) {
    stopCapture();
    // Wait for an in-flight upload before clearing the last shared point.
    busy = true;
    render();
    try {
      while (uploading) await new Promise(resolve => setTimeout(resolve, 50));
      await api('stop-location');
    } catch { el('location-status').textContent = 'GPS stopped on this device. The last shared point could not be cleared; it will become stale.'; }
    finally { busy = false; render(); }
    return;
  }
  if (!navigator.geolocation) { el('location-status').textContent = 'Location is unavailable on this device.'; return; }
  sharing = true;
  lastSent = 0;
  el('share').textContent = 'Stop sharing location';
  el('location-status').textContent = 'Waiting for your permission and a GPS fix…';
  watch = navigator.geolocation.watchPosition(point => {
    latest = { latitude: point.coords.latitude, longitude: point.coords.longitude, accuracy: point.coords.accuracy, timestamp: point.timestamp };
    void upload();
  }, error => {
    if (error.code === 1) stopCapture();
    el('location-status').textContent = 'Location could not be fetched. Check device permissions. Your help response is still saved.';
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  timer = setInterval(() => void upload(), 15000);
});
window.addEventListener('pagehide', stopCapture);
void refresh();
setInterval(() => void refresh(), 10000);
