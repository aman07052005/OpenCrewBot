import { activeGmailAccount } from "./composio";
import { gmailProxy, retrieveGmailDemo, verifyGmail, type GmailReadArgs } from "./gmail-integration";
import { integrationVerification, recordIntegrationFailure, recordIntegrationSuccess } from "./integration-status";
import { InputError } from "./errors";

export const gmailVerificationKey = (id: string) => `gmail-profile:${id}`;
export async function verifyGmailConnection() {
  const account = await activeGmailAccount();
  if (!account) throw new InputError("Connect one authorized Gmail test mailbox first.");
  const key = gmailVerificationKey(account.id);
  try {
    const result = await verifyGmail(gmailProxy(process.env.COMPOSIO_API_KEY ?? "", account.userId, account.id));
    await recordIntegrationSuccess(key);
    return result;
  } catch {
    const error = new InputError("Gmail profile check failed. Check the connection and read-only OAuth permission.");
    await recordIntegrationFailure(key, error);
    throw error;
  }
}
export async function verifiedGmailAccount() {
  const account = await activeGmailAccount();
  if (!account) throw new InputError("Connect one authorized Gmail test mailbox first.");
  const verification = await integrationVerification(gmailVerificationKey(account.id));
  if (!verification.lastSuccessfulAt || verification.lastError) throw new InputError("Verify the Gmail test connection first.");
  return account;
}
/** Called only after the persistent owner approval has been atomically claimed. */
export async function executeGmailRead(args: GmailReadArgs) {
  const account = await verifiedGmailAccount();
  if (account.id !== args.accountId) throw new Error("The approved Gmail connection is no longer active.");
  return retrieveGmailDemo(gmailProxy(process.env.COMPOSIO_API_KEY ?? "", account.userId, account.id), args.subject);
}
