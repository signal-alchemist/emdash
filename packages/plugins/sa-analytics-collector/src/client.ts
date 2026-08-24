export type ClientEventName =
  | "page_view"
  | "section_exposure"
  | "scroll_depth"
  | "cta_exposure"
  | "cta_click"
  | "form_start"
  | "form_submit"
  | "conversion"
  | "revenue"
  | "experiment_exposure";

export interface ClientEventContext {
  anonymousId: string;
  sessionId: string;
  contentId?: string;
  deploymentSha?: string;
  experiment?: { experimentId: string; variantId: string; assignedAt: string };
  campaign?: {
    source?: string;
    medium?: string;
    campaign?: string;
    term?: string;
    content?: string;
    clickId?: string;
  };
}

export interface AnalyticsClientOptions {
  endpoint: string;
  context: () => ClientEventContext;
  batchSize?: number;
  flushIntervalMs?: number;
  enabled?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface QueuedClientEvent {
  version: 1;
  eventId: string;
  eventName: ClientEventName;
  occurredAt: string;
  path: string;
  referrer?: string;
  viewport: { width: number; height: number };
  context: ClientEventContext;
  payload: Record<string, unknown>;
}

export interface AnalyticsClient {
  track(eventName: ClientEventName, payload?: Record<string, unknown>): void;
  flush(reason?: string): Promise<void>;
  destroy(): void;
}

export function createAnalyticsClient(options: AnalyticsClientOptions): AnalyticsClient {
  const batchSize = options.batchSize ?? 20;
  const flushIntervalMs = options.flushIntervalMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const queue: QueuedClientEvent[] = [];
  let timer: number | undefined;
  let destroyed = false;
  let flushing: Promise<void> | undefined;

  const isEnabled = () => !destroyed && (options.enabled?.() ?? true);

  const schedule = () => {
    if (timer !== undefined || queue.length === 0 || !isEnabled()) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      void flush("interval");
    }, flushIntervalMs);
  };

  const send = async (events: QueuedClientEvent[], reason: string): Promise<void> => {
    const body = JSON.stringify({ version: 1, reason, events });

    if (reason === "pagehide" && typeof navigator.sendBeacon === "function") {
      const accepted = navigator.sendBeacon(
        options.endpoint,
        new Blob([body], { type: "application/json" }),
      );
      if (accepted) return;
    }

    const response = await fetchImpl(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: reason === "pagehide",
      credentials: "same-origin",
    });

    if (!response.ok) {
      throw new Error(`Analytics collection failed with ${response.status}`);
    }
  };

  const flush = async (reason = "manual"): Promise<void> => {
    if (flushing) return flushing;
    if (!isEnabled() || queue.length === 0) return;

    const batch = queue.splice(0, batchSize);
    flushing = send(batch, reason)
      .catch((error: unknown) => {
        queue.unshift(...batch);
        throw error;
      })
      .finally(() => {
        flushing = undefined;
        if (queue.length > 0) schedule();
      });

    return flushing;
  };

  const onPageHide = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    void flush("pagehide");
  };

  window.addEventListener("pagehide", onPageHide);

  return {
    track(eventName, payload = {}) {
      if (!isEnabled()) return;

      queue.push({
        version: 1,
        eventId: crypto.randomUUID(),
        eventName,
        occurredAt: new Date().toISOString(),
        path: window.location.pathname,
        referrer: document.referrer || undefined,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        context: options.context(),
        payload,
      });

      if (queue.length >= batchSize) {
        void flush("batch-size");
      } else {
        schedule();
      }
    },

    flush,

    destroy() {
      destroyed = true;
      window.removeEventListener("pagehide", onPageHide);
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      queue.length = 0;
    },
  };
}
