// env.ts
//
// Loads .env, and must be imported BEFORE any module that reads process.env.
//
// This is a module rather than two lines in server.ts on purpose: ES module
// imports are hoisted and evaluated before any statement in the importing
// file, so `dotenv.config()` written as a statement in server.ts would run
// *after* agent.ts had already been evaluated — too late for anything
// agent.ts read at import time. As an import, this is ordered correctly.
//
// override: true because dotenv otherwise leaves any pre-existing environment
// variable alone, so a stale machine- or user-level ANTHROPIC_API_KEY would
// silently win over this project's .env and editing .env would appear to do
// nothing at all. This project's .env is the source of truth.

import dotenv from "dotenv";

dotenv.config({ override: true });
