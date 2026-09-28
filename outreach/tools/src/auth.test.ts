// Tests for the Outreach token handling, using a fake Outreach login server.
// Run with `npm test` from the repo root.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OutreachAuth, type StoredToken } from "./auth.js";

async function tokenFileWith(token: StoredToken) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "outreach-auth-"));
  const file = path.join(dir, "token.json");
  await fs.writeFile(file, JSON.stringify(token));
  return file;
}

/** A fake Outreach that rotates refresh tokens: each one works exactly once. */
function fakeOutreach() {
  let counter = 1;
  const valid = new Set(["refresh-1"]);
  const calls: string[] = [];

  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const used = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
    calls.push(used);

    if (!valid.delete(used)) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
    }

    counter += 1;
    valid.add(`refresh-${counter}`);
    return new Response(
      JSON.stringify({ access_token: `access-${counter}`, refresh_token: `refresh-${counter}`, expires_in: 7200 }),
      { status: 200 },
    );
  }) as typeof fetch;

  return { fetchFn, calls };
}

const expired: StoredToken = { access_token: "access-1", refresh_token: "refresh-1", expires_at: 0 };

function authFor(tokenFile: string, fetchFn: typeof fetch) {
  return new OutreachAuth({ tokenFile, clientId: "id", clientSecret: "secret", redirectUri: "https://example.com/cb", fetchFn, now: () => 1_000_000 });
}

test("a still-valid access token is used without refreshing", async () => {
  const outreach = fakeOutreach();
  const file = await tokenFileWith({ ...expired, expires_at: 99_999_999 });

  assert.equal(await authFor(file, outreach.fetchFn).getAccessToken(), "access-1");
  assert.equal(outreach.calls.length, 0);
});

test("the new refresh token is saved to disk as soon as it's issued", async () => {
  const outreach = fakeOutreach();
  const file = await tokenFileWith(expired);

  assert.equal(await authFor(file, outreach.fetchFn).getAccessToken(), "access-2");

  const saved = JSON.parse(await fs.readFile(file, "utf8")) as StoredToken;
  assert.equal(saved.refresh_token, "refresh-2");
});

test("ten simultaneous requests cause exactly one refresh", async () => {
  const outreach = fakeOutreach();
  const auth = authFor(await tokenFileWith(expired), outreach.fetchFn);

  const tokens = await Promise.all(Array.from({ length: 10 }, () => auth.getAccessToken()));

  assert.equal(outreach.calls.length, 1);
  assert.ok(tokens.every((t) => t === "access-2"));
});

test("a restarted server picks up the rotated token and keeps working", async () => {
  const outreach = fakeOutreach();
  const file = await tokenFileWith(expired);

  await authFor(file, outreach.fetchFn).forceRefresh(); // first server rotates refresh-1 → refresh-2
  const token = await authFor(file, outreach.fetchFn).forceRefresh(); // "restarted" server

  assert.equal(token, "access-3");
  assert.deepEqual(outreach.calls, ["refresh-1", "refresh-2"]);
});

test("a missing token file gives a plain-English instruction", async () => {
  const auth = authFor("/nonexistent/token.json", fakeOutreach().fetchFn);
  await assert.rejects(auth.getAccessToken(), /No Outreach token found/);
});
