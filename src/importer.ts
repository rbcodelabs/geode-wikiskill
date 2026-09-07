import type { Outcome, TraceEvent } from "./model";
import { eligibleTrace, redactTrace } from "./privacy";
import { ThreadsAdapter } from "./threads-adapter";

export class TraceImporter {
  cursor?: string;
  sourceRevision?: string;
  constructor(
    private readonly adapter: ThreadsAdapter,
    private readonly consent: ReadonlySet<string>,
    private readonly secrets: readonly string[],
    cursor?: string,
    private readonly expectedRevision?: string,
  ) {
    this.cursor = cursor;
    this.sourceRevision = expectedRevision;
  }

  async importNext(
    limit = 100,
  ): Promise<{ events: TraceEvent[]; cursor: string; redactions: number }> {
    limit = Math.max(1, Math.min(500, Math.floor(limit)));
    const api = this.adapter.requireApi();
    const sources = await this.listSources();
    const source = sources.find((item) =>
      Boolean(item.projectId && this.consent.has(item.projectId)),
    );
    if (!source)
      return { events: [], cursor: this.cursor ?? "", redactions: 0 };
    if (
      this.cursor &&
      this.expectedRevision &&
      source.revision !== this.expectedRevision
    )
      throw new Error(
        "Trace source revision changed; reset or reconcile the import cursor",
      );
    const chunk = await api.traces.readChunk(source.sourceId, {
      cursor: this.cursor,
      limit,
    });
    const output: TraceEvent[] = [];
    let redactions = 0;
    for (const event of chunk.events) {
      if (!event.invokedSkill) continue;
      const data = record(event.data);
      const derived: TraceEvent = {
        id: `${source.sourceId}:${event.index}`,
        origin: stringField(data, "origin"),
        projectId: source.projectId,
        skill: event.invokedSkill,
        text:
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data),
        outcome: outcomeField(data),
      };
      // Agent Threads filters own-origin sources; this second check rejects nested/spoofed origin metadata too.
      if (!eligibleTrace(derived, this.consent)) continue;
      const redacted = redactTrace(derived.text, this.secrets);
      redactions += redacted.redactions;
      output.push({ ...derived, text: redacted.text });
    }
    // Cursor is committed only after every event is filtered and sanitized.
    this.cursor = chunk.nextCursor ?? chunk.cursor ?? "";
    this.sourceRevision = chunk.revision;
    return { events: output, cursor: this.cursor, redactions };
  }

  async prepareBatch(
    checkpoints: Readonly<
      Record<
        string,
        {
          cursor?: string;
          revision: string;
          contentHash: string;
          byteLength: number;
          complete: boolean;
        }
      >
    >,
    maxEvents = 100,
  ): Promise<{
    events: TraceEvent[];
    checkpoints: Record<
      string,
      {
        cursor?: string;
        revision: string;
        contentHash: string;
        byteLength: number;
        complete: boolean;
      }
    >;
    redactions: number;
  }> {
    maxEvents = Math.max(1, Math.min(500, Math.floor(maxEvents)));
    const api = this.adapter.requireApi();
    const next = structuredClone(checkpoints) as Record<
      string,
      {
        cursor?: string;
        revision: string;
        contentHash: string;
        byteLength: number;
        complete: boolean;
      }
    >;
    const events: TraceEvent[] = [];
    let redactions = 0;
    let pageCursor: string | undefined;
    const seenPages = new Set<string>();
    let sourceEof = false;
    while (!sourceEof && events.length < maxEvents) {
      const page = await api.traces.listSources({
        cursor: pageCursor,
        limit: Math.min(100, maxEvents),
      });
      sourceEof = page.eof;
      for (const source of page.sources) {
        if (events.length >= maxEvents) break;
        if (!source.projectId || !this.consent.has(source.projectId)) continue;
        const checkpoint = checkpoints[source.sourceId];
        if (checkpoint && checkpoint.revision !== source.revision)
          throw new Error(
            `Trace source revision changed for ${source.sourceId}`,
          );
        if (checkpoint && source.byteLength < checkpoint.byteLength)
          throw new Error(`Trace source shrank for ${source.sourceId}`);
        if (
          checkpoint &&
          source.byteLength === checkpoint.byteLength &&
          source.contentHash !== checkpoint.contentHash
        )
          throw new Error(`Trace source was replaced for ${source.sourceId}`);
        if (checkpoint?.complete && source.byteLength === checkpoint.byteLength)
          continue;
        const chunk = await api.traces.readChunk(source.sourceId, {
          cursor: checkpoint?.cursor,
          limit: maxEvents - events.length,
        });
        const converted = this.convert(
          source.sourceId,
          source.projectId,
          chunk.events,
        );
        events.push(...converted.events);
        redactions += converted.redactions;
        if (chunk.contentHash !== source.contentHash)
          throw new Error(
            `Trace content hash changed while reading ${source.sourceId}`,
          );
        next[source.sourceId] = {
          cursor: chunk.nextCursor ?? checkpoint?.cursor,
          revision: chunk.revision,
          contentHash: chunk.contentHash,
          byteLength: source.byteLength,
          complete: chunk.eof,
        };
      }
      if (!sourceEof) {
        if (!page.nextCursor || seenPages.has(page.nextCursor))
          throw new Error("Trace source pagination did not advance");
        seenPages.add(page.nextCursor);
        pageCursor = page.nextCursor;
      }
    }
    // `next` is a proposal. The caller atomically persists it with derived evidence.
    return { events, checkpoints: next, redactions };
  }

  private convert(
    sourceId: string,
    projectId: string | undefined,
    events: readonly import("./threads-contract").ProviderTraceEvent[],
  ): { events: TraceEvent[]; redactions: number } {
    const output: TraceEvent[] = [];
    let redactions = 0;
    for (const event of events) {
      const data = record(event.data);
      if (!event.invokedSkill) continue;
      const derived: TraceEvent = {
        id: `${sourceId}:${event.index}`,
        origin: stringField(data, "origin"),
        projectId,
        skill: event.invokedSkill,
        text:
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data),
        outcome: outcomeField(data, event.type),
      };
      if (!eligibleTrace(derived, this.consent)) continue;
      const redacted = redactTrace(derived.text, this.secrets);
      redactions += redacted.redactions;
      output.push({ ...derived, text: redacted.text });
    }
    return { events: output, redactions };
  }
  private async listSources(): Promise<
    readonly import("./threads-contract").TraceSource[]
  > {
    const api = this.adapter.requireApi();
    const sources: import("./threads-contract").TraceSource[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await api.traces.listSources({ cursor, limit: 100 });
      sources.push(...page.sources);
      if (page.eof) break;
      if (!page.nextCursor || seen.has(page.nextCursor))
        throw new Error("Trace source pagination did not advance");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (true);
    return sources;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
function outcomeField(
  value: Record<string, unknown>,
  eventType?: string,
): Outcome {
  const outcome = value.outcome;
  if (outcome === "success" || outcome === "failure") return outcome;
  if (eventType === "result")
    return value.is_error === true ? "failure" : "success";
  return "unknown";
}
