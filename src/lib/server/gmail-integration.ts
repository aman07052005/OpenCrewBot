/** Fixed, read-only Gmail demo via Composio's authenticated proxy. No arbitrary URLs or queries. */
export const GMAIL_SUBJECT = /^OpenCrewBot Demo [A-Za-z0-9-]{4,32}$/;
export const GMAIL_DEMO_BODY = "OpenCrewBot synthetic test: revenue 120 units 12.";
export const GMAIL_ACCOUNT_ID = /^ca_[A-Za-z0-9_-]{1,120}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROXY = "https://backend.composio.dev/api/v3.1/tools/execute/proxy";
const MAX_RESPONSE = 128 * 1024;
type Query = Record<string, string>;
type Json = Record<string, unknown>;
export type GmailReadArgs = { accountId: string; subject: string };
export type GmailGet = (path: string, query?: Query) => Promise<unknown>;
export function validateGmailArgs(value: unknown): GmailReadArgs {
  const a = object(value);
  if (Object.keys(a).length !== 2 || typeof a.accountId !== "string" || !GMAIL_ACCOUNT_ID.test(a.accountId) || typeof a.subject !== "string" || !GMAIL_SUBJECT.test(a.subject)) throw new Error("Use the designated synthetic subject and one authorized Gmail connection.");
  return { accountId: a.accountId, subject: a.subject };
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gmail returned an unexpected response.");
  return value as Json;
}
/** No provider errors, headers, tokens or raw response bodies escape this boundary. */
export function gmailProxy(apiKey: string, userId: string, accountId: string, fetcher: typeof fetch = fetch): GmailGet {
  if (!apiKey || !userId || !GMAIL_ACCOUNT_ID.test(accountId)) throw new Error("Gmail connection is not configured.");
  return async (path, query = {}) => {
    if (path !== "/profile" && path !== "/messages" && !/^\/messages\/[A-Za-z0-9_-]{1,128}$/.test(path)) throw new Error("Unsupported Gmail read operation.");
    const endpoint = BASE + path;
    try {
      const response = await fetcher(PROXY, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { "Content-Type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ connected_account_id: accountId, user_id: userId, endpoint, method: "GET", parameters: Object.entries(query).map(([name, value]) => ({ name, value, type: "query" })) }) });
      if (!response.ok || !response.body) throw new Error("Provider request failed.");
      const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_RESPONSE) throw new Error("Response exceeds limit."); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (result.status !== 200) throw new Error("Gmail read failed.");
      return result.data;
    } catch { throw new Error("Gmail provider request failed or exceeded its limit. Check the authorized read-only connection."); }
  };
}
export async function verifyGmail(get: GmailGet) {
  const profile = object(await get("/profile", { fields: "emailAddress" }));
  if (typeof profile.emailAddress !== "string" || !/^[^@\s]+@[^@\s]+$/.test(profile.emailAddress)) throw new Error("Gmail profile verification failed.");
  // The actual address is deliberately not returned or persisted.
  return { verified: true, provider: "gmail", simulated: false } as const;
}
function subjectOf(payload: Json): string | undefined {
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const subject = headers.find((h) => h && typeof h === "object" && String(h.name).toLowerCase() === "subject");
  return typeof subject?.value === "string" ? subject.value : undefined;
}
function plainText(payload: Json): string {
  const parts = payload.mimeType === "text/plain" ? [payload] : payload.mimeType === "multipart/alternative" && Array.isArray(payload.parts) ? payload.parts.filter((p) => p && p.mimeType === "text/plain") : [];
  if (parts.length !== 1) throw new Error("Use a plain-text synthetic message without attachments.");
  const body = object(parts[0].body);
  if (body.attachmentId || typeof body.data !== "string" || body.data.length > 2048 || !/^[A-Za-z0-9_-]+={0,2}$/.test(body.data)) throw new Error("Unsupported synthetic message body.");
  const text = Buffer.from(body.data, "base64url").toString("utf8").trim();
  if (text !== GMAIL_DEMO_BODY) throw new Error("Message does not contain the designated synthetic test body; no content retained.");
  return text;
}
export async function retrieveGmailDemo(get: GmailGet, subject: string) {
  if (!GMAIL_SUBJECT.test(subject)) throw new Error("Invalid synthetic test subject.");
  // Search only for the designated message in the inbox, never a general mailbox listing.
  const list = object(await get("/messages", { q: `in:inbox subject:"${subject}"`, maxResults: "2", fields: "messages(id),nextPageToken" }));
  if (!Array.isArray(list.messages) || list.messages.length !== 1 || list.nextPageToken) throw new Error("Expected exactly one matching synthetic inbox message. Use a unique demo subject.");
  const id = object(list.messages[0]).id;
  if (typeof id !== "string" || !MESSAGE_ID.test(id)) throw new Error("Invalid Gmail message identifier.");
  const path = `/messages/${id}`;
  const meta = object(await get(path, { format: "metadata", metadataHeaders: "Subject", fields: "id,payload(headers(name,value))" }));
  if (meta.id !== id || subjectOf(object(meta.payload)) !== subject) throw new Error("Gmail subject did not match the approved synthetic subject.");
  const full = object(await get(path, { format: "full", fields: "id,payload(mimeType,headers(name,value),body(data,size,attachmentId),parts(mimeType,body(data,size,attachmentId)))" }));
  const payload = object(full.payload);
  if (full.id !== id || subjectOf(payload) !== subject) throw new Error("Gmail message changed or did not match.");
  return { provider: "gmail", simulated: false, synthetic: true, messageId: id, subject, body: plainText(payload), operation: "read-only", sent: false } as const;
}
