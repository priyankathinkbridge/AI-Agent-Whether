// weatherTier.ts
//
// Deterministic weather rating shared by weather-server.ts. Rates an hour on
// a 5-tier scale from whichever of temperature/rain/wind scores worst, and
// finds the longest run of consecutive hours that clears "Good" — computed
// here, not left for the LLM to work out from a day's worth of raw numbers.

export type WeatherTier = "Excellent" | "Good" | "Acceptable" | "Not ideal" | "Avoid";

const TIER_BY_RANK: WeatherTier[] = ["Avoid", "Not ideal", "Acceptable", "Good", "Excellent"];
const GOOD_RANK = TIER_BY_RANK.indexOf("Good"); // 3

interface HourWeather {
  temperatureC: number;
  precipitationProbabilityPercent: number;
  windSpeedKmh: number;
}

function rainRank(rain: number): number {
  if (rain < 10) return 4;
  if (rain < 30) return 3;
  if (rain <= 50) return 2;
  if (rain <= 70) return 1;
  return 0;
}

function windRank(wind: number): number {
  if (wind < 15) return 4;
  if (wind < 30) return 3;
  if (wind <= 40) return 2;
  if (wind <= 50) return 1;
  return 0;
}

function tempRank(temp: number): number {
  if (temp >= 20 && temp <= 30) return 4;
  if (temp >= 15 && temp <= 35) return 3;
  if (temp >= 10 && temp <= 40) return 2;
  if (temp >= 5 && temp <= 45) return 1;
  return 0;
}

export function rateHour(hour: HourWeather): WeatherTier {
  const rank = Math.min(
    rainRank(hour.precipitationProbabilityPercent),
    windRank(hour.windSpeedKmh),
    tempRank(hour.temperatureC)
  );
  return TIER_BY_RANK[rank];
}

export interface BestWindow {
  startTime: string; // "HH:00", matches the hourly entries' `time` field
  endTime: string; // "HH:00", exclusive — the hour after the last good one ("24:00" if it runs to end of day)
  tier: WeatherTier; // the worst tier within the window (always "Good" or "Excellent")
}

/**
 * Longest run of consecutive hours (already in time order) rated "Good" or
 * better. Ties are broken by total rank (prefers more "Excellent" hours),
 * then by whichever run occurs first.
 *
 * `fromTime` ("HH:00") drops hours earlier than that before searching — pass
 * the current local hour when the date is today, so a question asked at 8 PM
 * can't come back recommending 7 AM this morning.
 */
export function findBestWindow(
  allHours: Array<{ time: string; tier: WeatherTier }>,
  fromTime?: string
): BestWindow | null {
  const hours = fromTime ? allHours.filter((h) => h.time >= fromTime) : allHours;
  if (hours.length === 0) return null;

  const rankOf = (tier: WeatherTier) => TIER_BY_RANK.indexOf(tier);

  let best: { start: number; end: number; rankSum: number } | null = null;
  let runStart = -1;
  let rankSum = 0;

  for (let i = 0; i <= hours.length; i++) {
    const isGood = i < hours.length && rankOf(hours[i].tier) >= GOOD_RANK;
    if (isGood) {
      if (runStart === -1) {
        runStart = i;
        rankSum = 0;
      }
      rankSum += rankOf(hours[i].tier);
    } else if (runStart !== -1) {
      const length = i - runStart;
      const currentBestLength = best ? best.end - best.start : 0;
      const isBetter = length > currentBestLength || (length === currentBestLength && rankSum > (best?.rankSum ?? -1));
      if (isBetter) best = { start: runStart, end: i, rankSum };
      runStart = -1;
    }
  }

  if (!best) return null;

  const worstRankInWindow = Math.min(...hours.slice(best.start, best.end).map((h) => rankOf(h.tier)));

  return {
    startTime: hours[best.start].time,
    endTime: hours[best.end]?.time ?? "24:00",
    tier: TIER_BY_RANK[worstRankInWindow],
  };
}
