/**
 * OUTREACH LOGIN TOKENS: the lesson that cost the most
 *
 * Outreach logs you in with two tokens:
 *   - an ACCESS token, good for about two hours, sent with every request
 *   - a REFRESH token, used to get a new access token when it expires
 *
 * The catch: every time you refresh, Outreach issues a NEW refresh token and
 * the old one immediately stops working. It's single-use.
 *
 * So if the server refreshes, gets a new refresh token, and then crashes
 * before saving it, the saved token is now dead and the server is locked out
 * until a human signs in again by hand.
 *
 * The rules this file follows:
 *   1. SAVE FIRST: the new token is written to disk (safely: write a temp
 *      file, then rename it over the old one) BEFORE anything uses it.
 *   2. ONE REFRESH AT A TIME: if ten requests notice an expired token at
 *      once, only one refresh happens and the other nine wait for it.
 *      Ten refreshes would mean nine of them used a dead token.
 *   3. RE-READ BEFORE REFRESHING: the file on disk is the source of truth,
 *      in case another process already rotated the token.
 */

import fs from "node:fs/promises";

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  /** When the access token expires, in milliseconds since 1970. */
  expires_at: number;
}

export interface OutreachAuthOptions {
  tokenFile: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const TOKEN_URL = "https://api.outreach.io/oauth/token";
const EXPIRY_MARGIN_MS = 60_000; // refresh a minute early, not a second late

export class OutreachAuth {
  private cached: StoredToken | null = null;
  private refreshing: Promise<StoredToken> | null = null;
  private opts: Required<OutreachAuthOptions>;

  constructor(options: OutreachAuthOptions) {
    this.opts = { fetchFn: fetch, now: Date.now, ...options };
  }

  async getAccessToken() {
    this.cached ??= await this.readTokenFile();

    if (this.cached.expires_at - EXPIRY_MARGIN_MS > this.opts.now()) {
      return this.cached.access_token;
    }

    return (await this.refresh()).access_token;
  }

  /** Called after a 401: the access token was rejected, so get a new one. */
  async forceRefresh() {
    this.cached = null;
    return (await this.refresh()).access_token;
  }

  /** Rule 2: everyone who asks while a refresh is running shares that one refresh. */
  private refresh() {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<StoredToken> {
    // Rule 3: use whatever is on disk now, not what we remembered.
    const current = await this.readTokenFile();

    const response = await this.opts.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        redirect_uri: this.opts.redirectUri,
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
      throw new Error(
        `Outreach token refresh failed (${response.status}). If this keeps happening, the saved refresh token ` +
          `is no longer valid: sign in again and save a fresh token to ${this.opts.tokenFile}.`,
      );
    }

    const next: StoredToken = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: this.opts.now() + Number(body.expires_in ?? 7200) * 1000,
    };

    // Rule 1: save BEFORE use. From this moment the old refresh token is dead,
    // so if this write fails we must stop loudly rather than carry on.
    try {
      await this.writeTokenFile(next);
    } catch (error) {
      throw new Error(
        `Outreach issued a new token but it could not be saved to ${this.opts.tokenFile}. ` +
          `The previous token is now invalid. Fix the file permissions and sign in again. (${String(error)})`,
      );
    }

    this.cached = next;
    return next;
  }

  private async readTokenFile(): Promise<StoredToken> {
    try {
      return JSON.parse(await fs.readFile(this.opts.tokenFile, "utf8")) as StoredToken;
    } catch {
      throw new Error(
        `No Outreach token found at ${this.opts.tokenFile}. Complete Outreach's OAuth sign-in once and save ` +
          `{"access_token","refresh_token","expires_at"} there (see outreach/playbook.md).`,
      );
    }
  }

  /** Write to a temp file, then rename. A crash mid-write can't leave a half-written token. */
  private async writeTokenFile(token: StoredToken) {
    const temp = `${this.opts.tokenFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(token, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.opts.tokenFile);
  }
}
