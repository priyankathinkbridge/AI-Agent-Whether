// weather-server.ts
//
// An MCP server that exposes ONE tool: get_weather_forecast.
// It knows nothing about Claude, chat, or the frontend — its only job is
// "given a place, a date, and an hour, return the forecast for that hour."
// Run it standalone with `npm run inspect` to test it before wiring up an LLM.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { geocodeLocation } from "./geocode.js";
import { rateHour, findBestWindow } from "./weatherTier.js";
import { fetchWithTimeout } from "./http.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// Open-Meteo's free tier serves up to 16 days; 7 covers "this weekend" and
// "next Tuesday" style questions without bloating every response.
const FORECAST_DAYS = 7;

const server = new McpServer({
  name: "weather-server",
  version: "1.0.0",
});

/** The user's local calendar date and hour in `timeZone`, from an ISO instant. */
function getLocalDateAndHour(nowIso: string, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowIso));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24, // "24" shows up at local midnight with hour12:false
  };
}

server.tool(
  "get_weather_forecast",
  "Get the weather forecast (temperature, rain chance, wind) for a named " +
    "place on a specific date. Pass 'hour' to get one hour's numbers, " +
    "including a computed 'tier' (Excellent/Good/Acceptable/Not ideal/Avoid) " +
    "— use that tier as-is, don't re-derive it from the raw numbers. Omit " +
    "'hour' to get the full day's hourly breakdown plus a 'bestWindow' field " +
    "(the longest consecutive stretch of Good-or-better hours still to come, " +
    "or null if none) — use that directly for 'best time to visit' questions " +
    "instead of scanning the hours yourself. Forecasts reach about a week ahead.",
  {
    location: z
      .string()
      .describe("Place name, e.g. 'Baner, Pune, Maharashtra'"),
    date: z
      .string()
      .describe("Date in YYYY-MM-DD format. Use today's date if the user just says 'today'."),
    hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .optional()
      .describe(
        "Hour of day in 24-hour format, e.g. 18 for 6pm. Omit this to get " +
          "every hour of the day back instead of just one."
      ),
    now: z
      .string()
      .describe("Current date/time in ISO 8601 — use the value given in your system context, not a guess"),
    timeZone: z
      .string()
      .describe("IANA timezone for 'now', e.g. 'Asia/Kolkata' — use the value given in your system context"),
  },
  async ({ location, date, hour, now, timeZone }) => {
    // Step 1: turn the place name into coordinates + timezone.
    const place = await geocodeLocation(location);

    if (!place) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find a location matching "${location}". Try a more specific name (add city/state).`,
          },
        ],
      };
    }

    const { latitude, longitude, timezone, name, admin1, country } = place;

    // Step 2: fetch the hourly forecast for those coordinates.
    const forecastRes = await fetchWithTimeout(
      "The weather service",
      `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
        `&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m` +
        `&timezone=${encodeURIComponent(timezone)}&forecast_days=${FORECAST_DAYS}`
    );
    const forecastData = await forecastRes.json();

    const times: string[] = forecastData.hourly.time;

    // Step 3a: no hour given — return every hour of the requested date so
    // the caller can compare across the whole day in one round trip.
    if (hour === undefined) {
      const dayIndexes = times
        .map((time, i) => ({ time, i }))
        .filter(({ time }) => time.startsWith(date));

      if (dayIndexes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No forecast data available for ${date} at ${name}. ` +
                `Forecasts only cover about the next ${FORECAST_DAYS} days — ask about a nearer date.`,
            },
          ],
        };
      }

      const hourly = dayIndexes.map(({ time, i }) => {
        const hourData = {
          time: time.slice(11), // "HH:00", the date prefix is redundant here
          temperatureC: forecastData.hourly.temperature_2m[i],
          precipitationProbabilityPercent:
            forecastData.hourly.precipitation_probability[i],
          windSpeedKmh: forecastData.hourly.wind_speed_10m[i],
          weatherCode: forecastData.hourly.weather_code[i],
        };
        return { ...hourData, tier: rateHour(hourData) };
      });

      // Only hours still ahead of the user can be recommended — asked at 8 PM,
      // "the best time today" must not come back with 7 AM this morning. Past
      // hours stay in `hourly` (useful for "how has the rain been today"),
      // they're just excluded from the recommendation.
      const localNow = getLocalDateAndHour(now, timeZone);
      const fromTime =
        date === localNow.date ? `${String(localNow.hour).padStart(2, "0")}:00` : undefined;

      const result = {
        location: [name, admin1, country].filter(Boolean).join(", "),
        date,
        hourly,
        bestWindow: findBestWindow(hourly, fromTime),
        ...(fromTime ? { bestWindowCountsFrom: fromTime } : {}),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }

    // Step 3b: the response is parallel arrays, so find the index that
    // matches the requested date+hour.
    const targetIso = `${date}T${String(hour).padStart(2, "0")}:00`;
    const index = times.indexOf(targetIso);

    if (index === -1) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No forecast data available for ${targetIso} at ${name}. ` +
              `Forecasts only cover about the next ${FORECAST_DAYS} days — ask about a nearer date.`,
          },
        ],
      };
    }

    const hourData = {
      temperatureC: forecastData.hourly.temperature_2m[index],
      precipitationProbabilityPercent:
        forecastData.hourly.precipitation_probability[index],
      windSpeedKmh: forecastData.hourly.wind_speed_10m[index],
      weatherCode: forecastData.hourly.weather_code[index],
    };

    const result = {
      location: [name, admin1, country].filter(Boolean).join(", "),
      dateTime: targetIso,
      ...hourData,
      tier: rateHour(hourData),
    };

    // MCP tool results are always returned as content blocks. We hand back
    // JSON as a text block — the LLM on the other end will parse and reason over it.
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// IMPORTANT: use console.error for logging, never console.log.
// stdout is reserved for MCP protocol messages — writing plain logs there
// will corrupt the connection and produce confusing JSON-parse errors.
console.error("Weather MCP server running on stdio");
