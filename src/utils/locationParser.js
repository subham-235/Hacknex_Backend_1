/**
 * Helper utility to parse latitude and longitude from various formats:
 * - Google Maps URL (e.g. https://maps.google.com/?q=22.5726,88.3639 or https://www.google.com/maps/@22.5726,88.3639,15z)
 * - Raw coordinate string (e.g. "22.5726, 88.3639")
 * - Object with { lat, lon } or { location }
 * - Direct lat, lon arguments
 */
function parseLatLon(input, secondaryLon) {
  // Case 1: Direct lat, lon numbers or numeric strings passed as (lat, lon)
  if (input !== undefined && secondaryLon !== undefined && input !== null && secondaryLon !== null) {
    const lat = parseFloat(input);
    const lon = parseFloat(secondaryLon);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon };
    }
  }

  // Case 2: Object input e.g. { lat, lon } or { location }
  if (typeof input === "object" && input !== null) {
    if (input.lat !== undefined && (input.lon !== undefined || input.lng !== undefined)) {
      const lat = parseFloat(input.lat);
      const lon = parseFloat(input.lon !== undefined ? input.lon : input.lng);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lat, lon };
      }
    }
    if (input.location) {
      input = input.location;
    }
  }

  // Case 3: String input (Google Maps URL or raw coordinate string)
  if (typeof input === "string") {
    const str = decodeURIComponent(input);

    // Regex 1: Matches q=lat,lon or loc:lat,lon or @lat,lon or place/lat,lon or search/lat,lon or ll=lat,lon
    const urlPattern = /(?:q=|loc:|@|place\/|search\/|ll=)(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i;
    const urlMatch = str.match(urlPattern);
    if (urlMatch) {
      const lat = parseFloat(urlMatch[1]);
      const lon = parseFloat(urlMatch[2]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lat, lon };
      }
    }

    // Regex 2: Matches general "lat, lon" float pair anywhere in the string
    const generalPattern = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/;
    const genMatch = str.match(generalPattern);
    if (genMatch) {
      const lat = parseFloat(genMatch[1]);
      const lon = parseFloat(genMatch[2]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lat, lon };
      }
    }
  }

  return null;
}

module.exports = { parseLatLon };

