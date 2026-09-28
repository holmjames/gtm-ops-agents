/**
 * SETTINGS LOADER
 *
 * All three operators read their credentials from ONE file: the `.env` at the
 * root of this repo (copied from `.env.example`). This walks up from wherever
 * the running code lives until it finds the repo root, the folder that holds
 * `.env.example`, and loads `.env` from there.
 *
 * Stopping at `.env.example` matters: it means we never accidentally pick up
 * some unrelated `.env` file further up your computer's folders.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

let loadedEnvPath: string | null = null;
let expectedEnvPath = ".env (at the repo root)";

export function loadRepoEnv(fromModuleUrl: string) {
  let dir = path.dirname(fileURLToPath(fromModuleUrl));

  while (true) {
    if (fs.existsSync(path.join(dir, ".env.example"))) {
      const envPath = path.join(dir, ".env");
      expectedEnvPath = envPath;

      if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        loadedEnvPath = envPath;
      }

      return { repoRoot: dir, envPath: loadedEnvPath };
    }

    const parent = path.dirname(dir);
    if (parent === dir) return { repoRoot: null, envPath: null };
    dir = parent;
  }
}

/** Read a required setting, with a plain-English error if it's missing. */
export function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to ${expectedEnvPath} and fill it in before running the server.`,
    );
  }

  return value;
}
