// server.ts
//
// The bridge between the browser and the agent. The browser never talks
// to Claude or MCP directly — it just POSTs a message here and gets text back.
// This is also where your ANTHROPIC_API_KEY actually lives (via .env),
// safely off the client.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import type Anthropic from "@anthropic-ai/sdk";
import { initAgent, handleUserMessage } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// In-memory conversation history — fine for a single-user practice project.
// A real multi-user app would key this by session/user id instead.
const history: Anthropic.MessageParam[] = [];

app.post("/api/chat", async (req, res) => {
  const { message, clientNow, timeZone } = req.body ?? {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  // clientNow/timeZone come from the browser's own Date/Intl (see index.html)
  // — that's the user's real "now", which the server/Claude can't know on
  // their own. Fall back to server time only if an older client omits them.
  if (typeof clientNow !== "string" || typeof timeZone !== "string") {
    console.error("Request missing clientNow/timeZone — falling back to server time, which may not match the user.");
  }
  const now = typeof clientNow === "string" ? clientNow : new Date().toISOString();
  const zone = typeof timeZone === "string" ? timeZone : "UTC";

  // history is shared across every request for the life of the server, so a
  // failed turn must never leave a partial mutation behind — that would
  // break every request after it too, not just this one. Snapshot the
  // length and truncate back to it if anything throws.
  const historyLengthBeforeTurn = history.length;

  try {
    const reply = await handleUserMessage(message, history, { now, timeZone: zone });
    res.json({ reply });
  } catch (err) {
    console.error("Error handling message:", err);
    history.length = historyLengthBeforeTurn;
    res.status(500).json({ error: "Something went wrong on the server." });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

initAgent()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Weather agent running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start MCP agent:", err);
    process.exit(1);
  });
