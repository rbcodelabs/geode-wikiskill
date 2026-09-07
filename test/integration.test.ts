import { describe, expect, it } from 'vitest';
import { ThreadsAdapter } from '../src/threads-adapter';
import { TraceImporter } from '../src/importer';
import { JobQueue } from '../src/jobs';
import { evaluateCandidate } from '../src/evaluation';
import { FakeThreadsApi } from './support/fake-threads';

describe('vertical pilot', () => {
  it('discovers late, imports incrementally, excludes own traces, runs one isolated candidate evaluation, and never promotes', async () => {
    const events = new EventTarget();
    const plugins: Record<string, unknown> = {};
    const adapter = new ThreadsAdapter(() => plugins['claude-threads'], events);
    adapter.start();
    expect(adapter.status).toBe('offline');
    const api = new FakeThreadsApi();
    plugins['claude-threads'] = { api: { v1: api } };
    events.dispatchEvent(new Event('claude-threads:api-ready'));
    expect(adapter.status).toBe('full');
    const importer = new TraceImporter(adapter, new Set(['project-1']), []);
    const first = await importer.importNext();
    expect(first.events.map(event => event.id)).toEqual(['source-1:0']);
    expect(first.cursor).toBe('2');
    expect((await importer.importNext()).events).toEqual([]);
    const queue = new JobQueue(adapter);
    const candidate = await queue.propose('integration-routing', 'Use the evidence');
    expect(candidate.content).toContain('candidate');
    const result = await evaluateCandidate(adapter, { skill: 'integration-routing', baseline: 'base', candidate: candidate.content, fixtures: [{ id: 'route', prompt: 'route' }], minimumMargin: 0.1 });
    expect(result.decision).toBe('review');
    expect(result.promoted).toBe(false);
  });

  it('fences stale API generations and remains browsable in read-only mode', () => {
    const api = new FakeThreadsApi({ capabilities: ['traces.listSources', 'traces.readChunk'] });
    const adapter = new ThreadsAdapter(() => ({ api: { v1: api } }), new EventTarget());
    adapter.start();
    expect(adapter.status).toBe('read-only');
    api.generation = 'new-generation';
    expect(() => adapter.requireApi()).toThrow(/generation/i);
  });

  it('does not advance a cursor when the trace source revision changes', async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(() => ({ api: { v1: api } }), new EventTarget());
    adapter.start();
    api.sourceRevision = 'new-hash';
    const importer = new TraceImporter(adapter, new Set(['project-1']), [], '2', 'old-hash');
    await expect(importer.importNext()).rejects.toThrow(/revision/i);
    expect(importer.cursor).toBe('2');
  });

  it('prepares independent checkpoints for every eligible source without mutating caller state', async () => {
    const api = new FakeThreadsApi({ sourceCount: 2 });
    const adapter = new ThreadsAdapter(() => ({ api: { v1: api } }), new EventTarget());
    adapter.start();
    const importer = new TraceImporter(adapter, new Set(['project-1']), []);
    const before = {};
    const batch = await importer.prepareBatch(before, 10);
    expect(batch.events.map(event => event.id)).toEqual(['source-1:0', 'source-2:0']);
    expect(Object.keys(batch.checkpoints)).toEqual(['source-1', 'source-2']);
    expect(batch.checkpoints['source-1']).toEqual({ cursor: '2', revision: 'hash-1', complete: false });
    expect(before).toEqual({});
  });

  it('exposes the active authoring run to provider-backed cancellation', async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(() => ({ api: { v1: api } }), new EventTarget()); adapter.start();
    await new JobQueue(adapter, cancel => { if (cancel) void cancel(); }).propose('integration-routing', 'evidence');
    expect(api.cancelledThreadRuns).toEqual(['author-run']);
  });
});
