import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailProxy, verifyGmail, retrieveGmailDemo, GMAIL_DEMO_BODY, validateGmailArgs } from '../src/lib/server/gmail-integration.ts';
const subject = 'OpenCrewBot Demo TEST2026';
const id = 'abc123';
const headers = [{ name: 'Subject', value: subject }];
const full = { id, payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from(GMAIL_DEMO_BODY).toString('base64url') } } };
const fake = (override = {}) => async (path, query) => path === '/messages' ? { messages: [{ id }], ...override.list } : query.format === 'metadata' ? { id, payload: { headers }, ...override.meta } : { ...full, ...override.full };
test('profile verification requires actual provider profile and does not expose the email address', async () => {
  assert.deepEqual(await verifyGmail(async (path, query) => { assert.equal(path, '/profile'); assert.equal(query.fields, 'emailAddress'); return { emailAddress: 'synthetic@example.com', token: 'secret' }; }), { verified: true, provider: 'gmail', simulated: false });
  await assert.rejects(verifyGmail(async () => ({ connected: true })), /verification failed/);
});
test('selected synthetic message read uses bounded search, verifies exact subject, decodes actual body', async () => {
  const calls = [];
  const result = await retrieveGmailDemo(async (path, query) => { calls.push({ path, query }); return fake()(path, query); }, subject);
  assert.equal(calls.length, 3); assert.equal(calls[0].query.q, `in:inbox subject:"${subject}"`); assert.equal(calls[0].query.maxResults, '2'); assert.equal(calls[1].query.format, 'metadata'); assert.equal(calls[2].query.format, 'full');
  assert.equal(result.body, GMAIL_DEMO_BODY); assert.equal(result.simulated, false); assert.equal(result.sent, false);
});
test('invalid subjects, multiple results and mismatched metadata fail closed before body retrieval', async () => {
  let calls = 0; await assert.rejects(retrieveGmailDemo(async () => { calls++; }, 'subject:anything'), /Invalid/); assert.equal(calls, 0);
  await assert.rejects(retrieveGmailDemo(fake({ list: { messages: [{ id }, { id: 'other' }] } }), subject), /exactly one/);
  await assert.rejects(retrieveGmailDemo(fake({ meta: { payload: { headers: [{ name: 'Subject', value: 'Other' }] } } }), subject), /did not match/);
  assert.throws(() => validateGmailArgs({ accountId: 'ca_test', subject, extra: true }));
});
test('only the known synthetic body is returned; attachment and other content rejected', async () => {
  await assert.rejects(retrieveGmailDemo(fake({ full: { payload: { ...full.payload, body: { data: Buffer.from('private content').toString('base64url') } } } }), subject), /no content retained/);
  await assert.rejects(retrieveGmailDemo(fake({ full: { payload: { ...full.payload, body: { attachmentId: 'x', data: full.payload.body.data } } } }), subject), /Unsupported/);
  const multipart = { mimeType: 'multipart/alternative', headers, parts: [full.payload, { mimeType: 'text/html', body: { data: 'aGVsbG8' } }] };
  assert.equal((await retrieveGmailDemo(fake({ full: { payload: multipart } }), subject)).body, GMAIL_DEMO_BODY);
});
test('proxy pins account, user, endpoint and GET; provider failures and oversized responses are not leaked', async () => {
  const get = gmailProxy('fake-key', 'test-user', 'ca_test', async (url, init) => {
    assert.equal(url, 'https://backend.composio.dev/api/v3.1/tools/execute/proxy'); assert.equal(init.redirect, 'error'); const data = JSON.parse(init.body); assert.equal(data.connected_account_id, 'ca_test'); assert.equal(data.user_id, 'test-user'); assert.equal(data.method, 'GET'); assert.equal(data.endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/profile'); return Response.json({ status: 200, data: { emailAddress: 'test@example.com' } });
  });
  assert.equal((await verifyGmail(get)).verified, true);
  await assert.rejects(get('/messages/abc/send'), /Unsupported/);
  const fail = gmailProxy('fake-key', 'test-user', 'ca_test', async () => Response.json({ status: 403, data: { token: 'secret' } }));
  await assert.rejects(verifyGmail(fail), (e) => /provider request failed/.test(e.message) && !e.message.includes('secret'));
  const huge = gmailProxy('fake-key', 'test-user', 'ca_test', async () => new Response('x'.repeat(132000)));
  await assert.rejects(verifyGmail(huge), /exceeded its limit/);
});
