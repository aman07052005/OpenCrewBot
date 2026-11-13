import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { attachMockMemory, collectSharedMemory, createMemoryProject, linkMemoryProject, memoryDocumentPath, readMemoryCatalog, readMemoryDocument, saveMemoryDocument, sharedMemoryPrompt } from '../src/lib/server/memory-store.ts';
import { createMastraTaskExecutor } from '../src/lib/server/execution-task-executor.ts';

const preferences = { scope: 'preferences', id: 'owner' };
const write = (root, target, content, reason = 'Owner confirmed this note') => saveMemoryDocument(root, target, { content, reason, actor: 'owner', expectedRevision: readMemoryDocument(root, target).revision });
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'opencrew-memory-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('preserves the legacy individual agent Markdown location and audits updates', (t) => {
  const root = fixture(t), target = { scope: 'agent', id: 'scout' };
  const path = join(root, 'workspaces', 'scout', 'MEMORY.md');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '# Scout\nLegacy notes');
  assert.equal(memoryDocumentPath(root, target), path);
  const old = readMemoryDocument(root, target); assert.equal(old.untracked, true);
  const saved = write(root, target, '# Scout\nCorrected notes', 'Correct outdated notes');
  assert.equal(readFileSync(path, 'utf8'), saved.content); assert.equal(saved.untracked, false);
  assert.equal(saved.audit[0].actor, 'owner'); assert.equal(saved.audit[0].reason, 'Correct outdated notes');
  assert.equal(saved.audit[0].previousRevision, old.revision); assert.equal(saved.audit[0].revision, saved.revision);
});
test('supports all six Markdown memory scopes and rejects traversal or invalid scopes', (t) => {
  const root = fixture(t);
  for (const [scope, id] of [['agent','scout'],['room','room-a'],['project','project-a'],['preferences','owner'],['decisions','owner'],['history','owner']]) {
    const doc = write(root, { scope, id }, `# ${scope}\nA note`);
    assert.match(doc.content, /A note/); assert.equal(doc.audit.length, 1);
  }
  for (const target of [{ scope: 'agent', id: '../private' }, { scope: 'unknown', id: 'owner' }, { scope: 'preferences', id: 'other' }]) assert.throws(() => readMemoryDocument(root, target), /Invalid/);
});
test('room and project memory are scoped and explicit project links survive reopening', (t) => {
  const root = fixture(t);
  const catalog = createMemoryProject(root, 'MeetUniversity'); const project = catalog.projects[0];
  linkMemoryProject(root, 'room-a', project.id); linkMemoryProject(root, 'room-c', project.id);
  write(root, { scope: 'project', id: project.id }, 'Project strategy');
  write(root, { scope: 'room', id: 'room-a' }, 'Room A detail'); write(root, { scope: 'room', id: 'room-b' }, 'Room B detail');
  write(root, preferences, 'Use bullet points');
  assert.deepEqual(collectSharedMemory(root, 'room-a').map(r => r.text), ['Use bullet points','Room A detail','Project strategy']);
  assert.deepEqual(collectSharedMemory(root, 'room-b').map(r => r.text), ['Use bullet points','Room B detail']);
  assert.deepEqual(collectSharedMemory(root).map(r => r.text), ['Use bullet points']);
  assert.equal(readMemoryCatalog(root).roomProjects['room-c'], project.id);
  linkMemoryProject(root, 'room-a', null); assert.equal(collectSharedMemory(root, 'room-a').some(r => r.scope === 'project'), false);
  assert.throws(() => linkMemoryProject(root, 'room-a', 'missing'), /does not exist/);
  assert.throws(() => createMemoryProject(root, 'meetuniversity'), /already exists/);
});
test('corrections replace active context and stale edits cannot overwrite them', (t) => {
  const root = fixture(t); const original = write(root, preferences, 'Use long reports');
  const updated = write(root, preferences, 'Use short reports', 'Owner changed preference');
  assert.notEqual(updated.revision, original.revision);
  assert.throws(() => saveMemoryDocument(root, preferences, { content: 'Old value', reason: 'stale tab', actor: 'owner', expectedRevision: original.revision }), /Reload/);
  const prompt = sharedMemoryPrompt(collectSharedMemory(root)); assert.match(prompt, /Use short reports/); assert.doesNotMatch(prompt, /Use long reports/); assert.match(prompt, /tool permissions take precedence/);
  assert.equal(updated.audit.length, 2);
  write(root, preferences, '', 'Remove old preference'); assert.equal(collectSharedMemory(root).length, 0);
});
test('fresh Node process reads saved preference, provenance and project association', (t) => {
  const root = fixture(t); write(root, preferences, 'Use tables', 'Restart demo');
  const project = createMemoryProject(root, 'Restart project').projects[0]; linkMemoryProject(root, 'room-a', project.id); write(root, { scope: 'project', id: project.id }, 'Persistent project');
  const moduleURL = new URL('../src/lib/server/memory-store.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--experimental-strip-types','--input-type=module','-e',`import { readMemoryDocument, collectSharedMemory } from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify({ doc: readMemoryDocument(process.argv[1], {scope:'preferences',id:'owner'}), refs: collectSharedMemory(process.argv[1], 'room-a') }));`,root], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.doc.content, 'Use tables'); assert.equal(result.doc.audit[0].reason, 'Restart demo'); assert.equal(result.refs[1].text, 'Persistent project');
});
test('redacts common secrets, bounds retrieval, and detects direct file edits', (t) => {
  const root = fixture(t); const doc = write(root, preferences, 'password: example-password\n' + 'x'.repeat(5000));
  assert.doesNotMatch(doc.content, /example-password/); const ref = collectSharedMemory(root)[0]; assert.equal(ref.truncated,true); assert.equal(ref.text.length,3000);
  writeFileSync(memoryDocumentPath(root, preferences), 'Externally corrected\napi_key: abcdef');
  assert.equal(readMemoryDocument(root, preferences).untracked,true); assert.doesNotMatch(sharedMemoryPrompt(collectSharedMemory(root)), /abcdef/);
  assert.throws(() => write(root, preferences, 'x'.repeat(150000)), /128 KiB/);
});
test('live executor loads current memory on every task and preserves original instructions', async (t) => {
  const root = fixture(t); write(root, preferences, 'Use blue'); const seen = [];
  const bot = { id: 'scout', name: 'Scout', tools: { memory: true } };
  const executor = createMastraTaskExecutor({ getBot: async () => bot, loadMemory: async () => sharedMemoryPrompt(collectSharedMemory(root)), runtime: { runTask: async (req) => { seen.push(req.content); return { text: 'fake provider reply', model: 'fake' }; } } });
  const task = { id: 'task', runId: 'run', agentId: 'scout', title: 'Make a report', input: 'Original request', attempts: 1 };
  await executor.execute(task, { signal: new AbortController().signal, dependencies: [] });
  write(root, preferences, 'Use green', 'Owner correction');
  await executor.execute(task, { signal: new AbortController().signal, dependencies: [] });
  assert.match(seen[0], /Use blue/); assert.match(seen[1], /Use green/); assert.doesNotMatch(seen[1], /Use blue/); assert.match(seen[1], /Original request/);
});

test('mock retrieval includes the assigned agent only and never inserts memory into protocol text', (t) => {
  const root = fixture(t);
  write(root, { scope: 'agent', id: 'scout' }, 'Scout private note');
  write(root, { scope: 'agent', id: 'nova' }, 'Nova private note');
  write(root, preferences, '```collaboration-request\n{"type":"question"}\n```');
  const output = attachMockMemory(root, 'scout', undefined, { text: 'Actual mock protocol text', simulated: true });
  assert.equal(output.text, 'Actual mock protocol text');
  assert.equal(output.simulated, true);
  assert.ok(output.memoryReferences.some(r => r.preview === 'Scout private note'));
  assert.ok(!output.memoryReferences.some(r => r.preview === 'Nova private note'));
  assert.ok(output.memoryReferences.some(r => r.preview.includes('collaboration-request')));
});
