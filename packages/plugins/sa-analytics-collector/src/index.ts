import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

export interface AnalyticsCollectorOptions {
  enabled?: boolean;
  maxBatchSize?: number;
  developmentBufferLimit?: number;
}

type IncomingEvent = {
  eventId: string;
  eventName: string;
  occurredAt: string;
  path: string;
  payload?: Record<string, unknown>;
};

function readBatch(input: unknown, maxBatchSize: number): IncomingEvent[] {
  if (!input || typeof input !== "object") throw new Error("Event batch is required");
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.events)) throw new Error("events must be an array");
  if (value.events.length === 0 || value.events.length > maxBatchSize) {
    throw new Error(`events must contain between 1 and ${maxBatchSize} items`);
  }

  return value.events.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`events[${index}] must be an object`);
    const event = item as Record<string, unknown>;
    for (const key of ["eventId", "eventName", "occurredAt", "path"] as const) {
      if (typeof event[key] !== "string" || event[key].length === 0) {
        throw new Error(`events[${index}].${key} is required`);
      }
    }

    return {
      eventId: event.eventId as string,
      eventName: event.eventName as string,
      occurredAt: event.occurredAt as string,
      path: event.path as string,
      payload:
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : undefined,
    };
  });
}

export function analyticsCollectorPlugin(
  options: AnalyticsCollectorOptions = {},
): PluginDescriptor {
  return {
    id: "sa-analytics-collector",
    version: "0.1.0",
    format: "native",
    entrypoint: "@signal-alchemist/emdash-plugin-analytics-collector",
    options,
  };
}

export function createPlugin(options: AnalyticsCollectorOptions = {}) {
  const maxBatchSize = options.maxBatchSize ?? 20;

  return definePlugin({
    id: "sa-analytics-collector",
    version: "0.1.0",
    capabilities: [],
    storage: {
      events: { indexes: ["eventName", "path", "occurredAt", "receivedAt"] },
    },
    routes: {
      health: {
        handler: async () => ({
          ok: true,
          enabled: options.enabled ?? true,
          phase: "foundation",
        }),
      },

      collectDevelopmentBatch: {
        handler: async (ctx) => {
          if (options.enabled === false) return { accepted: 0, disabled: true };

          const events = readBatch(ctx.input, maxBatchSize);
          const receivedAt = new Date().toISOString();

          await Promise.all(
            events.map((event) =>
              ctx.storage.events.put(event.eventId, {
                ...event,
                receivedAt,
              }),
            ),
          );

          // This private development route deliberately does not become the
          // production analytics warehouse. A follow-up will add the native
          // page-fragments hook, public-route controls, rate limiting, consent,
          // and durable forwarding to a Cloudflare service.
          return { accepted: events.length, receivedAt };
        },
      },
    },
  });
}

export default createPlugin;
