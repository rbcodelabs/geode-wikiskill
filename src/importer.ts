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
    const converted = this.convert(
      source.sourceId,
      source.projectId,
      chunk.events,
    );
    // Cursor is committed only after every event is filtered and sanitized.
    this.cursor = chunk.nextCursor;
    this.sourceRevision = chunk.revision;
    return {
      events: converted.events,
      cursor: this.cursor,
      redactions: converted.redactions,
    };
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
    progress: {
      sourcePageCursor?: string;
      maxSources?: number;
      maxBytes?: number;
    } = {},
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
    sourcePageCursor?: string;
    scannedSources: number;
    scannedBytes: number;
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
    let pageCursor: string | undefined = progress.sourcePageCursor;
    let scannedSources = 0,
      scannedBytes = 0;
    const maxSources = Math.max(1, progress.maxSources ?? 100),
      maxBytes = Math.max(1, progress.maxBytes ?? maxEvents * 65536);
    const seenPages = new Set<string>();
    let sourceEof = false;
    while (
      !sourceEof &&
      events.length < maxEvents &&
      scannedSources < maxSources &&
      scannedBytes < maxBytes
    ) {
      const page = await api.traces.listSources({
        cursor: pageCursor,
        limit: 1,
      });
      sourceEof = page.eof;
      for (const source of page.sources) {
        scannedSources += 1;
        scannedBytes += source.byteLength;
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
          cursor: chunk.nextCursor,
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
    return {
      events,
      checkpoints: next,
      redactions,
      sourcePageCursor: sourceEof ? undefined : pageCursor,
      scannedSources,
      scannedBytes,
    };
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
      for (const outcome of event.skillRunOutcomes ?? [])
        output.push({
          id: `${sourceId}:${outcome.invocationIndex}`,
          projectId,
          skill: outcome.invokedSkill,
          text: "",
          outcome: outcome.runOutcome,
        });
      if (!event.invokedSkill) continue;
      const derived: TraceEvent = {
        id: `${sourceId}:${event.index}`,
        origin: stringField(data, "origin"),
        projectId,
        skill: event.invokedSkill,
        text:
          typeof event.data === "string"
            ? event.data
            : (stringField(data, "text") ?? JSON.stringify(event.data)),
        outcome: "unknown",
      };
      if (!eligibleTrace(derived, this.consent)) continue;
      const redacted = redactTrace(derived.text, this.secrets);
      redactions += redacted.redactions;
      output.push({ ...derived, text: redacted.text });
    }
    const merged = new Map<string, TraceEvent>();
    for (const item of output) {
      const prior = merged.get(item.id);
      merged.set(item.id, {
        ...item,
        text: item.text || prior?.text || "",
        outcome:
          item.outcome === "unknown"
            ? (prior?.outcome ?? "unknown")
            : item.outcome,
      });
    }
    return { events: [...merged.values()], redactions };
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
