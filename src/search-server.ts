// search-server.ts
//
// An MCP server that exposes ONE tool: search_place_info.
// It answers questions a weather API has no concept of — opening hours,
// whether a place is currently open, closures, entry rules, local events —
// by searching the web via the Brave Search API. It knows nothing about
// weather, Claude, or chat; same separation of concerns as weather-server.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchWithTimeout } from "./http.js";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

if (!BRAVE_API_KEY) {
  console.error(
    "BRAVE_API_KEY is not set — search_place_info will respond with a " +
      "not-configured message instead of real results."
  );
}

const server = new McpServer({
  name: "search-server",
  version: "1.0.0",
});

server.tool(
  "search_place_info",
  "Search the web for facts about a specific place that a weather forecast " +
    "cannot answer — opening hours, whether it is currently open, closures, " +
    "entry rules, or local events. Do NOT use this for temperature, rain, " +
    "or wind questions; use get_weather_forecast for those.",
  {
    query: z
      .string()
      .describe(
        "A specific web search query, e.g. 'Baner playground Pune opening hours'"
      ),
  },
  async ({ query }) => {
    if (!BRAVE_API_KEY) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "Web search is not configured (missing BRAVE_API_KEY). Answer " +
              "from weather data only, and tell the user this couldn't be confirmed.",
          },
        ],
      };
    }

    const res = await fetchWithTimeout(
      "Brave Search",
      `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": BRAVE_API_KEY,
        },
      }
    );

    if (!res.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Brave Search request failed (HTTP ${res.status}). Answer without this information and say it couldn't be confirmed.`,
          },
        ],
      };
    }

    const data = await res.json();
    const results = (data.web?.results ?? [])
      .slice(0, 5)
      .map((r: { title: string; description: string; url: string }) => ({
        title: r.title,
        snippet: r.description,
        url: r.url,
      }));

    if (results.length === 0) {
      return {
        content: [
          { type: "text" as const, text: `No web results found for "${query}".` },
        ],
      };
    }

    // MCP tool results are always returned as content blocks. We hand back
    // JSON as a text block — the LLM on the other end will parse and reason over it.
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// IMPORTANT: use console.error for logging, never console.log.
// stdout is reserved for MCP protocol messages — writing plain logs there
// will corrupt the connection and produce confusing JSON-parse errors.
console.error("Search MCP server running on stdio");
