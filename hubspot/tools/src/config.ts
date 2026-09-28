import { loadRepoEnv, requireEnv } from "@gtm-ops/shared";

// Load credentials from the single .env at the repo root (see .env.example).
// All three operators share that one file.
loadRepoEnv(import.meta.url);

export { requireEnv };
