// =============================================================================
// The facade's connection to the real Attio MCP server, including OAuth.
//
// This replaces fastmcp's one-liner `Client(url, auth="oauth")` from the Python
// baseline. The TS SDK does the OAuth protocol work (discovery, dynamic client
// registration, PKCE, token exchange, refresh). We supply an
// OAuthClientProvider, which is a small storage object the SDK calls to save
// and load client info, tokens and the PKCE verifier, plus a way to send the
// user to the login page.
//
// Flow on first run:
//   1. connect() -> Attio answers 401 -> SDK calls redirectToAuthorization(url)
//   2. we open that URL in your browser; you log in to Attio
//   3. Attio redirects to http://localhost:<FACADE_PORT>/oauth/callback?code=...
//   4. main.ts's callback route hands the query string to completeOAuth()
//   5. transport.finishAuth(params) exchanges the code for tokens (saveTokens)
//   6. we connect again with a fresh transport, now with a token
// Later runs: tokens are read from .oauth/attio.json, so no browser step.
// =============================================================================
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthClientMetadata,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import fs from "node:fs";
import path from "node:path";
import open from "open";

const STORE_DIR = path.resolve(".oauth");
const STORE_FILE = path.join(STORE_DIR, "attio.json");

interface OAuthStore {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
}

function loadStore(): OAuthStore {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveStore(store: OAuthStore) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

/** File-backed OAuth provider. Delete the .oauth folder to force a fresh login. */
class FileOAuthProvider implements OAuthClientProvider {
  private store = loadStore();

  constructor(private readonly callbackUrl: string) {}

  get redirectUrl() {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "AttioExample facade",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return this.store.clientInformation;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.store.clientInformation = info;
    saveStore(this.store);
  }
  tokens() {
    return this.store.tokens;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.store.tokens = tokens;
    saveStore(this.store);
  }
  saveCodeVerifier(codeVerifier: string) {
    this.store.codeVerifier = codeVerifier;
    saveStore(this.store);
  }
  codeVerifier() {
    if (!this.store.codeVerifier) throw new Error("No PKCE code verifier saved");
    return this.store.codeVerifier;
  }
  async redirectToAuthorization(authorizationUrl: URL) {
    console.log("\n[facade] Attio needs you to log in. Opening your browser...");
    console.log("[facade] If it doesn't open, paste this URL:\n" + authorizationUrl.href + "\n");
    await open(authorizationUrl.href).catch(() => {});
  }
}

// The callback route (in main.ts) resolves this when Attio redirects back.
let resolveCallback: ((params: URLSearchParams) => void) | undefined;

/** Called by the /oauth/callback route with the redirect's query string. */
export function completeOAuth(params: URLSearchParams) {
  resolveCallback?.(params);
}

/**
 * Connect to Attio's MCP server, doing the OAuth browser login if needed.
 * Works against servers without auth too (e.g. dev/fake-attio.ts).
 */
export async function connectToAttio(attioUrl: string, callbackUrl: string): Promise<Client> {
  const provider = new FileOAuthProvider(callbackUrl);
  const url = new URL(attioUrl);
  const clientInfo = { name: "attio-example-facade", version: "0.1.0" };

  const client = new Client(clientInfo);
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  try {
    await client.connect(transport);
    return client;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }

  // Not authorized yet: the provider has already opened the login page.
  console.log("[facade] Waiting for the Attio login to finish...");
  const params = await new Promise<URLSearchParams>((resolve) => (resolveCallback = resolve));
  await transport.finishAuth(params);

  // Reconnect with a fresh client and transport, now holding a token.
  const authed = new Client(clientInfo);
  await authed.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  console.log("[facade] Attio login complete.");
  return authed;
}
