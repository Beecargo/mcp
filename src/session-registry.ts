import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

type SessionState = {
  apiKey: string | null;
};

type SessionRegistryEntry = {
  transport: StreamableHTTPServerTransport;
  state: SessionState;
  lastActivity: number;
};

export class McpSessionRegistry {
  private readonly sessions = new Map<string, SessionRegistryEntry>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly maxSessions: number,
    private readonly ttlMs: number,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  startPeriodicPrune(intervalMs = 60_000): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => this.prune(), intervalMs);
    this.pruneTimer.unref?.();
  }

  prune(now = Date.now()): void {
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastActivity > this.ttlMs) {
        void entry.transport.close();
        this.sessions.delete(id);
      }
    }
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): SessionRegistryEntry | undefined {
    return this.sessions.get(id);
  }

  attach(
    id: string,
    transport: StreamableHTTPServerTransport,
    state: SessionState,
  ): void {
    this.sessions.set(id, {
      transport,
      state,
      lastActivity: Date.now(),
    });
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  touch(id: string, now = Date.now()): void {
    const entry = this.sessions.get(id);
    if (entry) entry.lastActivity = now;
  }

  canAcceptNewSession(now = Date.now()): boolean {
    this.prune(now);
    return this.sessions.size < this.maxSessions;
  }
}
