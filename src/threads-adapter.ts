import type { ThreadsApiV1, ThreadsPluginShape } from "./threads-contract";

export type DependencyStatus = "offline" | "read-only" | "full";
const TRACE_CAPABILITIES = ["traces.listSources", "traces.readChunk"];
const REQUIRED_FULL = [
  ...TRACE_CAPABILITIES,
  "threads.create",
  "threads.send",
  "threads.wait",
  "threads.cancel",
  "constrainedRuns.create",
  "constrainedRuns.wait",
  "constrainedRuns.cancel",
];

export class ThreadsAdapter {
  status: DependencyStatus = "offline";
  private api?: ThreadsApiV1;
  private generation?: string;
  private readonly ready = () => this.connect();
  private readonly stopping = () => this.disconnect();

  constructor(
    private readonly discover: () => unknown,
    private readonly events: EventTarget,
  ) {}

  start(): void {
    this.events.addEventListener("claude-threads:api-ready", this.ready);
    this.events.addEventListener("claude-threads:api-stopping", this.stopping);
    this.connect();
  }

  stop(): void {
    this.events.removeEventListener("claude-threads:api-ready", this.ready);
    this.events.removeEventListener(
      "claude-threads:api-stopping",
      this.stopping,
    );
    this.disconnect();
  }

  requireApi(): ThreadsApiV1 {
    if (!this.api) throw new Error("Agent Threads is unavailable");
    if (this.api.generation !== this.generation) {
      this.disconnect();
      throw new Error(
        "Agent Threads API generation changed; operation must be reconciled",
      );
    }
    return this.api;
  }

  private connect(): void {
    const candidate = (this.discover() as ThreadsPluginShape | undefined)?.api
      ?.v1;
    if (!candidate || candidate.apiVersion !== 1) return this.disconnect();
    this.api = candidate;
    this.generation = candidate.generation;
    const capabilities = new Set(candidate.capabilities);
    this.status = REQUIRED_FULL.every((capability) =>
      capabilities.has(capability),
    )
      ? "full"
      : TRACE_CAPABILITIES.every((capability) => capabilities.has(capability))
        ? "read-only"
        : "offline";
  }

  private disconnect(): void {
    this.api = undefined;
    this.generation = undefined;
    this.status = "offline";
  }
}
