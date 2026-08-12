// agent.ts
//
// This is the "brain" of the app. It:
//   1. Spawns weather-server.ts, places-server.ts, and search-server.ts as
//      child processes and speaks MCP to each of them.
//   2. Sends the user's message + the combined MCP tool list to Claude.
//   3. When Claude wants to call a tool, forwards that call to whichever MCP
//      server owns it, feeds the result back, and repeats until Claude has
//      a final answer.
//
// It knows nothing about Express or HTML — server.ts is the only thing
// that calls into this file, so this logic is reusable in a CLI, a test,
// or a different frontend later.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Reads ANTHROPIC_API_KEY from the environment automatically.
const anthropic = new Anthropic();

const MODEL = "claude-sonnet-5";

/** The user's local date/time, as reported by their own device — see index.html. */
interface ClientContext {
  now: string; // ISO 8601, e.g. "2026-08-11T19:03:00.000Z"
  timeZone: string; // IANA name, e.g. "Asia/Kolkata"
}

// Rebuilt on every turn (not a constant) so "now" is always the date/time
// the user's own device just reported, never a guess from training data.
function buildSystemPrompt({ now, timeZone }: ClientContext): string {
  return `You are a helpful assistant that tells people whether it's a good time to visit an outdoor place.

The user's current local date/time is ${now} (timezone: ${timeZone}). Always resolve "today", "now", "this evening", and similar relative references against this — never guess the current date/time yourself. Whenever you call get_weather_forecast, get_place_status, or get_nearby_places, pass this exact date/time and timezone as their "now"/"timeZone" arguments.

When a user asks about visiting a place at a certain time:
1. Work out the location, date, and hour they mean using the current date/time above. If they don't give a location's region, use your best judgement, and ask them to confirm if it's genuinely ambiguous.
2. For weather-suitability questions, call get_weather_forecast — never guess the weather, or its tier, yourself.
   - Pass "hour" when they name a specific time (e.g. "7pm today"). The result includes a computed "tier" — use it as-is.
   - Omit "hour" when they're asking about the day in general, or specifically for "best time to visit" (e.g. "how's the rain today", "best time to visit today"). The result includes every hour's tier plus a "bestWindow" field (the longest consecutive Good-or-better stretch, already computed) — use "bestWindow" directly rather than scanning the hours yourself. For today, "bestWindow" already excludes hours that have passed, so never recommend an earlier hour from "hourly" even if it looks better.
3. For a single named place's open/closed status, call get_place_status first — it's structured OpenStreetMap data and more reliable than a web search for this. If it can't find the place, or returns openNow: null (no usable hours data for that place — common for informal public spaces), fall back to search_place_info.
4. If get_place_status says the named place is closed (or has no data) at the time asked about, call get_nearby_places for the same area and type and suggest the nearest alternative with openNow: true instead of just reporting the closure — e.g. "Baner playground is closed by 7pm, but [X] nearby is open."
5. When the user is discovering/listing places rather than naming one (e.g. "what playgrounds are open near Baner Pune", "places to visit today"), call get_nearby_places directly — it returns several candidates with their open/closed status in one call.
6. Use search_place_info only for real-world facts the two tools above don't cover (events, informal closures, general place info) — never to guess weather or a specific place's official hours.
7. If asked about a date beyond what get_weather_forecast can cover (it reaches about a week out), say so plainly rather than guessing — offer general seasonal knowledge only if you clearly label it as general/typical, not a checked forecast.
8. The tier scale, for reference, is not something you compute — get_weather_forecast always returns it already: Excellent, Good, Acceptable, "Not ideal", Avoid, worst-scoring factor wins (e.g. great temp and wind but 60% rain still comes back "Not ideal").
9. Format the answer as:
   - One verdict line: the returned tier plus a matching emoji — "Excellent ✅" / "Good ✅" / "Acceptable 🟡" / "Not ideal 🟠" / "Avoid 🔴". Fold in open/closed status here too when relevant (e.g. "Not ideal 🟠 — and it's closed by 7 PM").
   - A short stat block, one line each: "🌡️ <temp>°C", "🌧️ <rain>% rain probability", "💨 <wind> km/h wind".
   - One short plain-English sentence explaining the verdict.
   - If the tier is "Not ideal" or "Avoid" for a specific hour the user asked about, call get_weather_forecast again without "hour" for that date and report its "bestWindow" instead of picking a single hour yourself — e.g. "I'd recommend 6–9 PM instead, when it stays Good or better." If "bestWindow" is null, say the whole day looks poor rather than inventing an exception.
   - For open-ended "best time" questions, call get_weather_forecast without "hour" and report "bestWindow" as the headline range, not a single hour.

Keep the tone short, warm, and conversational — like a friend checking the forecast for you — but always follow the structure above rather than free-form prose.`;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface McpConnection {
  client: Client;
  tools: McpToolInfo[];
}

// Routes each Claude tool call to the MCP client that actually owns it —
// filled in once, in initAgent(), from every connected server's tool list.
let toolClientMap: Map<string, Client>;
let claudeTools: Anthropic.Tool[];

async function connectServer(
  scriptFile: string,
  label: string
): Promise<McpConnection | null> {
  try {
    // The SDK's default env for a spawned server is a locked-down safe list
    // (PATH, HOME, etc.) — it deliberately does NOT inherit the parent's
    // env, so .env-loaded vars like BRAVE_API_KEY would silently never
    // reach the child otherwise, even when set correctly.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(__dirname, scriptFile)],
      env,
    });

    const client = new Client({ name: `weather-agent-client-${label}`, version: "1.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    console.error(
      `Connected to ${label} MCP server. Tools available: ${tools.map((t) => t.name).join(", ")}`
    );

    return { client, tools };
  } catch (err) {
    console.error(`Failed to connect to ${label} MCP server:`, err);
    return null;
  }
}

/** Call this once when your server starts, before handling any messages. */
export async function initAgent(): Promise<void> {
  const weather = await connectServer("weather-server.ts", "weather");
  if (!weather) {
    throw new Error("Could not connect to the weather MCP server — this tool is required.");
  }

  // Places and search are supplementary (opening hours, discovery, general
  // facts) — if either fails to connect, degrade instead of failing startup.
  const places = await connectServer("places-server.ts", "places");
  if (!places) {
    console.error(
      "Continuing without the places tool — 'is X open' and 'places near me' won't be answerable."
    );
  }

  const search = await connectServer("search-server.ts", "search");
  if (!search) {
    console.error(
      "Continuing without the search tool — general fact questions won't be answerable."
    );
  }

  const connections = [weather, places, search].filter(
    (c): c is McpConnection => c !== null
  );

  toolClientMap = new Map();
  claudeTools = [];
  for (const { client, tools } of connections) {
    for (const tool of tools) {
      toolClientMap.set(tool.name, client);
      claudeTools.push({
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
      });
    }
  }
}

/**
 * Runs one user turn through Claude, handling any tool calls it makes
 * along the way, and returns the final text answer. `history` is mutated
 * in place so the caller can keep passing the same array for multi-turn
 * conversations. `clientContext` carries the user's own device's current
 * date/time so Claude resolves "today"/"now" correctly instead of guessing.
 */
export async function handleUserMessage(
  userMessage: string,
  history: Anthropic.MessageParam[],
  clientContext: ClientContext
): Promise<string> {
  history.push({ role: "user", content: userMessage });

  const systemPrompt = buildSystemPrompt(clientContext);

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: history,
    tools: claudeTools,
  });

  // Claude may need several tool calls before it's ready to answer (e.g.
  // check opening hours, then check the forecast). Loop until it stops
  // asking for tools.
  while (response.stop_reason === "tool_use") {
    history.push({ role: "assistant", content: response.content });

    // Every tool_use block below MUST get a matching tool_result pushed, even
    // on failure — history is a single array shared across every request for
    // the life of the server, so a dangling tool_use here doesn't just fail
    // this turn, it permanently breaks every future message too (the
    // Anthropic API rejects any history with an unpaired tool_use).
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        try {
          const client = toolClientMap.get(block.name);
          if (!client) {
            throw new Error(`No MCP connection found for tool "${block.name}"`);
          }

          console.error(`Calling tool: ${block.name}`, block.input);
          const result = await client.callTool({
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.content as Anthropic.ToolResultBlockParam["content"],
          });
        } catch (err) {
          console.error(`Tool call failed: ${block.name}`, err);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: [
              {
                type: "text",
                text: `Tool call failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          });
        }
      }
    }

    history.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: history,
      tools: claudeTools,
    });
  }

  history.push({ role: "assistant", content: response.content });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
