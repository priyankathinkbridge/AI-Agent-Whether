// geocode.ts
//
// Shared free geocoding helper (Open-Meteo), used by both weather-server.ts
// and places-server.ts. Open-Meteo's /search endpoint only matches a single
// name term — "Baner, Pune, Maharashtra" returns nothing at all if you send
// the whole comma-separated string, and a bare "Baner" alone can match a
// same-named village on the other side of the country before the Pune one.
// This tries progressively shorter prefixes of the comma-separated string,
// and among same-named candidates prefers the one whose region/country
// actually matches the rest of what was typed.

import { fetchWithTimeout } from "./http.js";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

export interface GeocodedPlace {
  latitude: number;
  longitude: number;
  timezone: string;
  name: string;
  admin1?: string;
  country?: string;
}

interface OpenMeteoGeocodeResult {
  latitude: number;
  longitude: number;
  timezone: string;
  name: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  country?: string;
}

export async function geocodeLocation(location: string): Promise<GeocodedPlace | null> {
  const parts = location.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  // Everything after the first comma is context we can use to pick the
  // right same-named place, e.g. "Pune, Maharashtra" for "Baner".
  const context = parts.slice(1).join(" ").toLowerCase();

  for (let take = parts.length; take >= 1; take--) {
    const query = parts.slice(0, take).join(", ");
    const res = await fetchWithTimeout(
      "The location lookup service",
      `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=10`
    );
    const data = await res.json();
    const results: OpenMeteoGeocodeResult[] = data.results ?? [];
    if (results.length === 0) continue;

    if (context) {
      const contextMatch = results.find((r) =>
        [r.admin1, r.admin2, r.admin3, r.country].some(
          (field) => typeof field === "string" && context.includes(field.toLowerCase())
        )
      );
      if (contextMatch) return toGeocodedPlace(contextMatch);
    }

    return toGeocodedPlace(results[0]);
  }

  return null;
}

function toGeocodedPlace(r: OpenMeteoGeocodeResult): GeocodedPlace {
  return {
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
    name: r.name,
    admin1: r.admin1,
    country: r.country,
  };
}
