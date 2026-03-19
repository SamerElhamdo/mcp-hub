#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startServer } from "../server.js";
import logger from "./logger.js";
import { readFileSync } from 'fs';
import {
  isMCPHubError,
} from "./errors.js";
import { fileURLToPath } from "url";
import { join } from "path";

// VERSION will be injected from package.json during build
/* global process.env.VERSION */


// Read version from package.json while in dev mode to get the latest version
// We can't do this production, due to issues when installed as global package on "bun"
// Ignore the esbuild build warning id: 'assign-to-define',
if (process.env.NODE_ENV != "production") {
  // Get the directory path of the current module
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  // Navigate up two directories to find package.json
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;
  process.env.VERSION = version;
}

// Custom failure handler for yargs
function handleParseError(msg, err) {
  // Ensure CLI parsing errors exit immediately with proper code
  logger.error(
    "CLI_ARGS_ERROR",
    "Failed to parse command line arguments",
    {
      message: msg || "Missing required arguments",
      help: "Use --help to see usage information",
      error: err?.message,
    },
    true,
    1
  ); // Add exit:true and exitCode:1
}


async function run() {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: mcp-hub [options]")
    .version(process.env.VERSION || "v0.0.0")
    .options({
      port: {
        alias: "p",
        describe: "Port to run the server on",
        type: "number",
        demandOption: true,
      },
      config: {
        alias: "c",
        describe: "Path to config file(s). Not required when using --database-url.",
        type: "array",
      },
      "database-url": {
        alias: "d",
        describe: "PostgreSQL connection URL for storing config. Overrides file-based config.",
        type: "string",
      },
      watch: {
        alias: "w",
        describe: "Watch for config file changes",
        type: "boolean",
        default: false,
      },
      "auto-shutdown": {
        describe: "Whether to automatically shutdown when no clients are connected",
        type: "boolean",
        default: false
      },
      "shutdown-delay": {
        describe:
          "Delay in milliseconds before shutting down when auto-shutdown is enabled and no clients are connected",
        type: "number",
        default: 0,
      },
    })
    .example("mcp-hub --port 3000 --config ./global.json")
    .example("mcp-hub --port 3000 --database-url postgresql://user:pass@localhost:5432/mcphub")
    .help("h")
    .alias("h", "help")
    .fail(handleParseError).argv;

  const databaseUrl = argv["database-url"] || process.env.DATABASE_URL;
  const config = argv.config;

  if (!databaseUrl && (!config || config.length === 0)) {
    handleParseError("Either --config or --database-url (or DATABASE_URL) is required", new Error("Missing config"));
    return;
  }

  try {
    await startServer({
      port: argv.port,
      config: config || [],
      databaseUrl: databaseUrl || undefined,
      watch: argv.watch && !databaseUrl,
      autoShutdown: argv["auto-shutdown"],
      shutdownDelay: argv["shutdown-delay"],
    });
  } catch (error) {
    process.exit(1)
  }
}

run()
