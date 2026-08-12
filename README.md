# Weather Visit-Advisor Agent — Tutorial

An AI agent that answers "is it a good time to visit X place?" by checking
a live weather forecast through an MCP server, then reasoning about it with
Claude. This is a working reference project — everything here has been
installed and test-run already, so it should work as-is once you add your
API key.

## How it fits together

```
Browser (public/index.html)
   |  fetch POST /api/chat  { message, clientNow, timeZone }
   v
Express server (src/server.ts)
   |  calls
   v
Agent logic (src/agent.ts)
   |  MCP protocol, over stdio (one child process per server)
   v
   +-- MCP server (src/weather-server.ts) -- HTTPS --> Open-Meteo API (no key needed)
   |
   +-- MCP server (src/places-server.ts)  -- HTTPS --> OpenStreetMap Nominatim + Overpass (no key needed)
   |
   +-- MCP server (src/search-server.ts)  -- HTTPS --> Brave Search API (BRAVE_API_KEY)

weather-server.ts and places-server.ts both share src/geocode.ts to turn a
place name into coordinates (see Step 2).
```

Only `agent.ts`, `weather-server.ts`, `places-server.ts`, and
`search-server.ts` know anything about MCP or Claude. `server.ts` is a thin
HTTP wrapper, and `index.html` is a dumb display — neither of them touches
your API key or the tool-calling logic directly. `index.html` does one more
thing beyond display, though: it reads the browser's own clock (`clientNow`,
`timeZone`) and sends it with every message, because neither the server nor
Claude has a reliable way to know "today"/"now" on their own.

## Step 1 — Install and configure

```bash
cd weather-agent
npm install
cp .env.example .env
```

Open `.env` and paste in your real key:
```
ANTHROPIC_API_KEY=sk-ant-...
```

`BRAVE_API_KEY` is optional. Without it, `search_place_info` (general facts
neither weather nor places data covers) just responds with a not-configured
message — everything else still works. `places-server.ts` needs no key at
all; OpenStreetMap's Nominatim and Overpass APIs are free and keyless.

## Step 2 — Understand the MCP servers first

- **`geocode.ts`** isn't a tool itself — it's a shared helper both
  `weather-server.ts` and `places-server.ts` call to turn a place name into
  coordinates. Open-Meteo's free geocoder only matches a single name term:
  send it `"Baner, Pune, Maharashtra"` as one string and it returns nothing;
  send it bare `"Baner"` and it can match a same-named village on the other
  side of the country before the one in Pune. `geocodeLocation()` retries
  with progressively shorter prefixes of a comma-separated string, and when
  there are several same-named candidates, prefers the one whose
  region/country matches the rest of what was typed.
- **`weather-server.ts`** does one job: given `location`, `date`, and
  optionally `hour`, it geocodes the place name and fetches the hourly
  forecast from Open-Meteo. Pass `hour` to get one exact hour's numbers;
  omit it to get every hour of that day back at once (so the agent can scan
  a whole day's rain outlook or pick the best hour without calling the tool
  24 times).
- **`places-server.ts`** answers what a weather API can't: is a place
  actually open right now? It has two tools — `get_place_status` for one
  named place (looked up via OpenStreetMap's Nominatim, reading its
  `opening_hours` tag) and `get_nearby_places` for discovery (Overpass API,
  searching an area for a type of place, e.g. "playground"). Both parse a
  *subset* of the OSM `opening_hours` syntax (24/7, and simple
  `Mo-Fr 08:00-20:00`-style ranges) and return `openNow: null` — not a
  guess — for anything more exotic or untagged, which is common for
  informal public spaces. `search_place_info` is the fallback for that.
- **`search-server.ts`** is the last resort: given a free-text `query`, it
  searches the web via Brave Search. Use it for facts neither of the above
  covers (events, informal closures, general place info) — not weather, not
  a specific place's official hours.

None of these files have **any idea Claude exists** — that separation is
the point of MCP. Read through them before moving on; everything downstream
depends on understanding what these tools return.

Test it in isolation, without any LLM in the loop:

```bash
npm run test:server
```

This spawns the server and asks it to list its tools — you should see the
`get_weather_forecast` tool and its schema printed as JSON. This confirms
the MCP handshake works before you add any AI reasoning on top.

For interactive testing (actually calling the tools with real inputs and
seeing live data), use the MCP Inspector instead:

```bash
npm run inspect          # weather-server.ts — fill in location, date, hour (or leave hour blank)
npm run inspect:places   # places-server.ts — try get_place_status or get_nearby_places
npm run inspect:search   # search-server.ts — fill in a query
```

## Step 3 — Understand the agent loop (`src/agent.ts`)

Key pieces:

- **`connectServer()` / `initAgent()`** — spawns `weather-server.ts`,
  `places-server.ts`, and `search-server.ts` as child processes, connects an
  MCP `Client` to each, and merges their tool lists into one array for
  Claude (converting `inputSchema` → `input_schema` along the way). It also
  builds a `toolClientMap` so a later tool call can be routed back to
  whichever server actually owns that tool name. If places or search fail
  to connect, the agent logs a warning and continues without that tool; if
  the weather server fails, startup fails — that tool is required.
- **`buildSystemPrompt()`** — this is where "good weather for an outdoor
  visit" gets defined (temperature range, rain chance threshold, wind
  threshold), and where the user's real current date/time gets embedded
  fresh on every turn (see `ClientContext` below). Claude only checks
  against criteria you actually write down, and only knows "today" because
  this function tells it.
- **`handleUserMessage()`** — sends your message + the tool list to Claude.
  If Claude responds wanting to call a tool (`stop_reason === "tool_use"`),
  it looks up the right MCP client for that tool name, calls it, feeds the
  result back to Claude, and repeats until Claude gives a final text
  answer. This loop **is** the agent.

Notice `ClientContext` (`now`, `timeZone`) is passed into `handleUserMessage`
from `server.ts` on every request — it's the browser's own clock, not
anything Claude or the server guesses. This matters: without a real
"today", every relative time ("this evening", "right now") is ambiguous to
an LLM, whose own sense of the date comes only from training data.

## Step 4 — Understand the web layer (`src/server.ts` + `public/index.html`)

`server.ts` starts the agent once (`initAgent()`), then exposes a single
`POST /api/chat` endpoint that calls `handleUserMessage()` and returns the
reply as JSON. It also serves `public/index.html` as a static file.

`index.html` is plain HTML/CSS/JS — no framework. It POSTs whatever you
type to `/api/chat` and renders the reply. Open it and read the `<script>`
tag at the bottom; it's about 20 lines.

## Step 5 — Run it

```bash
npm run dev
```

Open **http://localhost:3000** and try your example:

> "I want to visit the playground at 6pm, it's at Baner, Pune, Maharashtra"

Watch your terminal while you do this — the `console.error` lines will show
you the tool being called with the exact arguments Claude chose, which is
the best way to build intuition for what's actually happening under the
hood.

## Step 6 — Things to try changing (this is where the learning happens)

- Change the thresholds in `buildSystemPrompt()` (e.g. make rain tolerance
  stricter) and see how answers change.
- Ask about a time more than 3 days out — confirm the tool's "no forecast
  data available" fallback message triggers correctly, and Claude
  communicates that limitation to you instead of guessing.
- Ask a follow-up like "what about 8pm instead?" and confirm the
  conversation history (`history` array in `server.ts`) lets Claude
  remember the location without you repeating it.
- Ask "how's the rain today?" or "what's the best time to visit today?" and
  watch the terminal — Claude should call `get_weather_forecast` *without*
  `hour` and get the whole day back in one call, instead of calling it
  repeatedly.
- Ask "is [some named playground] open right now?" and watch `get_place_status`
  get called instead of `get_weather_forecast`. If it's closed (or has no
  hours data), Claude should follow up with `get_nearby_places` and suggest
  an open alternative rather than just reporting the closure.
- Ask "what playgrounds are near [some area]?" and watch `get_nearby_places`
  return several candidates with their open/closed status in one call.
- Ask about a place with an unusual/very informal name and confirm `openNow`
  comes back `null` (not a guessed `true`/`false`) when OpenStreetMap has no
  hours data for it — and that Claude falls back to `search_place_info`
  instead of inventing an answer.
- Look at how `places-server.ts` and `search-server.ts` were added alongside
  `weather-server.ts` — new files following the same shape, wired into
  `agent.ts`'s `connectServer()`/`toolClientMap` — as a template for adding
  a fourth tool, e.g. `get_air_quality`.

## Troubleshooting

- **"Failed to start MCP agent"** — usually a bad or missing
  `ANTHROPIC_API_KEY` in `.env`. This one is fatal on purpose — the
  weather tool is required.
- **`search_place_info` always says "not configured"** — `BRAVE_API_KEY` is
  missing from `.env`; this is a soft failure by design, not a crash.
- **`get_place_status`/`get_nearby_places` return `openNow: null` a lot** —
  expected, not a bug: most informal public spaces (small playgrounds
  especially) simply have no `opening_hours` tag in OpenStreetMap, and the
  parser deliberately returns `null` instead of guessing. Claude should
  fall back to `search_place_info` in that case.
- **Tool call seems to hang or error oddly** — check you never added a
  `console.log()` inside any of the `*-server.ts` files. Only
  `console.error()` is safe in a stdio MCP server; `console.log()` corrupts
  the protocol stream.
- **"Could not find a location"** — `geocode.ts` already retries shorter
  prefixes of a comma-separated string, but very obscure or misspelled
  names can still fail; try adding the state/country.
- **Answers seem to use the wrong date** — check the browser actually sent
  `clientNow`/`timeZone` (Network tab, `/api/chat` request body); the
  server logs a warning to its console if a request arrives without them.
