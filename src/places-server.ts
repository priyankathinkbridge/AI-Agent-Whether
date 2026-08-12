// places-server.ts
//
// An MCP server backed by free, keyless OpenStreetMap data. It exposes two tools:
//   - get_place_status: is a specific named place open right now?
//   - get_nearby_places: search an area for candidate places (e.g. "playgrounds
//     near Baner Pune"), each flagged with whether it's currently open.
// Structured OSM opening_hours data is more reliable for "is X open" than a
// generic web search snippet — search-server.ts stays around as a fallback
// for facts this can't cover (events, informal closures, general place info),
// and for places OSM simply has no hours tag for (openNow: null below).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { geocodeLocation } from "./geocode.js";
import { fetchWithTimeout } from "./http.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Nominatim's usage policy requires a descriptive User-Agent identifying the
// app — anonymous/browser-like User-Agents get blocked.
const USER_AGENT = "weather-agent-practice-project (educational use, no contact configured)";

const server = new McpServer({
  name: "places-server",
  version: "1.0.0",
});

// ---- Minimal OSM `opening_hours` support -----------------------------------
// The full spec (https://wiki.openstreetmap.org/wiki/Key:opening_hours) covers
// public holidays, sunrise/sunset, and more — deliberately out of scope here.
// We handle "24/7" and the common "Mo-Fr 08:00-20:00; Sa,Su 09:00-18:00" shape;
// anything else returns null (unknown) rather than a guessed answer, so the
// caller can fall back to search_place_info instead of trusting a bad parse.

interface HoursRange {
  days: Set<number>; // 0 = Sunday .. 6 = Saturday, JS Date convention
  startMin: number;
  endMin: number;
}

const DAY_INDEX: Record<string, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };

function parseOpeningHours(spec: string): HoursRange[] | null {
  const trimmed = spec.trim();
  if (trimmed === "24/7") {
    return [{ days: new Set([0, 1, 2, 3, 4, 5, 6]), startMin: 0, endMin: 24 * 60 }];
  }

  const ranges: HoursRange[] = [];
  for (const block of trimmed.split(";").map((s) => s.trim()).filter(Boolean)) {
    const match = block.match(/^([A-Za-z,-]+)\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!match) return null; // unsupported syntax — bail out to "unknown"

    const [, dayPart, sh, sm, eh, em] = match;
    const days = new Set<number>();
    for (const piece of dayPart.split(",")) {
      const rangeMatch = piece.match(/^([A-Za-z]{2})-([A-Za-z]{2})$/);
      if (rangeMatch) {
        const start = DAY_INDEX[rangeMatch[1]];
        const end = DAY_INDEX[rangeMatch[2]];
        if (start === undefined || end === undefined) return null;
        for (let d = start; ; d = (d + 1) % 7) {
          days.add(d);
          if (d === end) break;
        }
      } else {
        const d = DAY_INDEX[piece];
        if (d === undefined) return null;
        days.add(d);
      }
    }

    ranges.push({
      days,
      startMin: Number(sh) * 60 + Number(sm),
      endMin: Number(eh) * 60 + Number(em),
    });
  }

  return ranges;
}

/** Resolves an ISO instant to its local day-of-week and minute-of-day in `timeZone`. */
function getLocalDayAndMinutes(nowIso: string, timeZone: string): { day: number; minutes: number } {
  const date = new Date(nowIso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").slice(0, 3);
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? date.getUTCDay();
  const hour = Number(get("hour")) % 24; // "24" shows up at local midnight with hour12:false
  const minute = Number(get("minute"));
  return { day, minutes: hour * 60 + minute };
}

/** true/false if `spec` parses and covers `nowIso`; null if the syntax isn't supported. */
function isOpenNow(spec: string, nowIso: string, timeZone: string): boolean | null {
  const ranges = parseOpeningHours(spec);
  if (!ranges) return null;
  const { day, minutes } = getLocalDayAndMinutes(nowIso, timeZone);
  return ranges.some((r) => r.days.has(day) && minutes >= r.startMin && minutes < r.endMin);
}

// ---- Tools ------------------------------------------------------------------

const NOW_PARAMS = {
  now: z
    .string()
    .describe("Current date/time in ISO 8601 — use the value given in your system context, not a guess"),
  timeZone: z
    .string()
    .describe("IANA timezone for 'now', e.g. 'Asia/Kolkata' — use the value given in your system context"),
};

server.tool(
  "get_place_status",
  "Check whether a specific named place is currently open, using OpenStreetMap " +
    "opening-hours data. Use for 'is X open' questions about one named place. " +
    "Returns openNow: true/false, or null if there's no usable hours data for " +
    "that place (common for informal public spaces like small playgrounds) — " +
    "fall back to search_place_info in that case. Not for weather — use " +
    "get_weather_forecast for that.",
  {
    place: z.string().describe("Place name with enough context to disambiguate, e.g. 'Baner playground, Pune'"),
    ...NOW_PARAMS,
  },
  async ({ place, now, timeZone }) => {
    const searchRes = await fetchWithTimeout(
      "OpenStreetMap place lookup",
      `${NOMINATIM_URL}?q=${encodeURIComponent(place)}&format=json&limit=1&extratags=1`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    const results = await searchRes.json();

    if (!searchRes.ok || !Array.isArray(results) || results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find "${place}" in OpenStreetMap. Try search_place_info instead, or ask the user for a more specific name.`,
          },
        ],
      };
    }

    const match = results[0];
    const hoursSpec: string | undefined = match.extratags?.opening_hours;

    const result = {
      name: match.display_name as string,
      openNow: hoursSpec ? isOpenNow(hoursSpec, now, timeZone) : null,
      hoursTag: hoursSpec ?? null,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  }
);

interface OverpassElement {
  tags?: { name?: string; opening_hours?: string };
}

server.tool(
  "get_nearby_places",
  "Search an area for candidate places to visit (e.g. 'playgrounds near " +
    "Baner Pune'), each flagged with whether it's currently open (openNow: " +
    "true/false/null — null means no usable hours data for that place). Use " +
    "this to discover/list places, not for a place the user already named — " +
    "use get_place_status for that.",
  {
    location: z.string().describe("Area to search around, e.g. 'Baner, Pune, Maharashtra'"),
    type: z.string().describe("What kind of place, e.g. 'playground', 'park', 'restaurant'"),
    ...NOW_PARAMS,
  },
  async ({ location, type, now, timeZone }) => {
    const place = await geocodeLocation(location);

    if (!place) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find an area matching "${location}". Try a more specific name (add city/state).`,
          },
        ],
      };
    }

    const { latitude, longitude } = place;

    // OSM tag values are usually just the plain English word (leisure=playground,
    // amenity=restaurant, etc.) — try the common keys rather than maintaining a
    // large lookup table.
    const value = type.trim().toLowerCase().replace(/\s+/g, "_");
    const clauses = ["leisure", "amenity", "shop", "tourism"]
      .map((key) => `nwr["${key}"="${value}"](around:2000,${latitude},${longitude});`)
      .join("\n  ");
    const query = `[out:json][timeout:25];\n(\n  ${clauses}\n);\nout center tags 10;`;

    // Overpass is the slowest of the free endpoints we use (its own query
    // timeout is set to 25s above), so give it more room than the default.
    const overpassRes = await fetchWithTimeout(
      "The nearby-places search",
      OVERPASS_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
      },
      15000
    );

    if (!overpassRes.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Overpass request failed (HTTP ${overpassRes.status}). Try search_place_info instead.`,
          },
        ],
      };
    }

    const overpassData = await overpassRes.json();
    const elements: OverpassElement[] = overpassData.elements ?? [];

    if (elements.length === 0) {
      return {
        content: [
          { type: "text" as const, text: `No "${type}" found near "${location}".` },
        ],
      };
    }

    const results = elements.slice(0, 8).map((el) => {
      const tags = el.tags ?? {};
      const hoursSpec = tags.opening_hours;
      return {
        name: tags.name ?? "Unnamed place",
        openNow: hoursSpec ? isOpenNow(hoursSpec, now, timeZone) : null,
        hoursTag: hoursSpec ?? null,
      };
    });

    return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// IMPORTANT: use console.error for logging, never console.log.
// stdout is reserved for MCP protocol messages — writing plain logs there
// will corrupt the connection and produce confusing JSON-parse errors.
console.error("Places MCP server running on stdio");
