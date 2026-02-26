/**
 * Resilience module — wraps tool handlers with failure tracking,
 * n8n alerting, and automatic degradation of broken tools.
 *
 * Health state is persisted to DATA_DIR/tool-health.json so it
 * survives restarts. When a handler hits FAILURE_THRESHOLD
 * consecutive failures it is marked degraded and an alert is
 * POSTed to the N8N_ALERT_WEBHOOK_URL.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR || "/data";
const HEALTH_FILE = join(DATA_DIR, "tool-health.json");
const N8N_ALERT_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL || "";
const SERVER_URL = process.env.PUBLIC_URL || "";
const FAILURE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HandlerHealth {
  failures: number;
  degraded: boolean;
  lastError?: string;
  lastFailure?: string;
}

type HealthState = Record<string, HandlerHealth>;

export interface Handler<T = unknown> {
  name: string;
  fn: (args: T) => Promise<unknown>;
}

export interface McpContent {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadHealth(): HealthState {
  try {
    const raw = readFileSync(HEALTH_FILE, "utf-8");
    return JSON.parse(raw) as HealthState;
  } catch {
    return {};
  }
}

function saveHealth(state: HealthState): void {
  ensureDataDir();
  writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Health helpers
// ---------------------------------------------------------------------------

function getHandler(state: HealthState, key: string): HandlerHealth {
  return state[key] ?? { failures: 0, degraded: false };
}

function recordSuccess(toolName: string, handlerName: string): void {
  const key = `${toolName}:${handlerName}`;
  const state = loadHealth();
  state[key] = { failures: 0, degraded: false };
  saveHealth(state);
}

function recordFailure(
  toolName: string,
  handlerName: string,
  error: string,
): boolean {
  const key = `${toolName}:${handlerName}`;
  const state = loadHealth();
  const h = getHandler(state, key);
  h.failures += 1;
  h.lastError = error;
  h.lastFailure = new Date().toISOString();
  if (h.failures >= FAILURE_THRESHOLD) {
    h.degraded = true;
  }
  state[key] = h;
  saveHealth(state);
  return h.degraded;
}

export function isDegraded(toolName: string, handlerName: string): boolean {
  const key = `${toolName}:${handlerName}`;
  const state = loadHealth();
  return getHandler(state, key).degraded;
}

/**
 * Manually reset a degraded handler so it will be retried.
 */
export function resetTool(toolName: string, handlerName: string): void {
  const key = `${toolName}:${handlerName}`;
  const state = loadHealth();
  state[key] = { failures: 0, degraded: false };
  saveHealth(state);
}

// ---------------------------------------------------------------------------
// N8n alerting
// ---------------------------------------------------------------------------

async function alertN8n(
  tool: string,
  error: string,
  failureCount: number,
): Promise<void> {
  if (!N8N_ALERT_WEBHOOK_URL) return;
  try {
    await fetch(N8N_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool,
        error,
        failureCount,
        timestamp: new Date().toISOString(),
        serverUrl: SERVER_URL,
      }),
    });
  } catch (err) {
    // Alerting is best-effort — never let it crash the handler chain.
    console.error("[resilience] Failed to alert n8n:", err);
  }
}

// ---------------------------------------------------------------------------
// Core wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an ordered list of handlers for a given tool with resilience logic.
 *
 * Handlers are tried in order. Degraded handlers are skipped when a
 * non-degraded fallback exists further down the list. If every handler
 * is degraded, a "[DISABLED]" MCP content response is returned.
 *
 * On success the handler's failure counter is reset. On failure the
 * counter increments and, if it crosses the threshold, n8n is alerted.
 */
export function withResilience<T>(
  toolName: string,
  handlers: Array<{ name: string; fn: (args: T) => Promise<unknown> }>,
): (args: T) => Promise<McpContent> {
  return async (args: T): Promise<McpContent> => {
    const state = loadHealth();

    // Check if every handler is degraded
    const allDegraded = handlers.every((h) => {
      const key = `${toolName}:${h.name}`;
      return getHandler(state, key).degraded;
    });

    if (allDegraded) {
      return {
        content: [
          {
            type: "text",
            text: `[DISABLED] Tool "${toolName}" is temporarily disabled — all handlers are degraded. Use resetTool() to re-enable.`,
          },
        ],
      };
    }

    let lastError: unknown;

    for (let i = 0; i < handlers.length; i++) {
      const handler = handlers[i];
      const key = `${toolName}:${handler.name}`;
      const health = getHandler(state, key);
      const hasFallback = i < handlers.length - 1;

      // Skip degraded handlers when a fallback exists
      if (health.degraded && hasFallback) {
        continue;
      }

      try {
        const result = await handler.fn(args);
        recordSuccess(toolName, handler.name);
        const text =
          typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err);
        lastError = err;
        const nowDegraded = recordFailure(
          toolName,
          handler.name,
          errorMsg,
        );
        if (nowDegraded) {
          await alertN8n(
            `${toolName}:${handler.name}`,
            errorMsg,
            FAILURE_THRESHOLD,
          );
        }
        // Continue to next handler
      }
    }

    // All handlers failed (but not all permanently degraded yet)
    const errorText =
      lastError instanceof Error
        ? lastError.message
        : String(lastError);
    return {
      content: [
        {
          type: "text",
          text: `[ERROR] Tool "${toolName}" failed: ${errorText}`,
        },
      ],
    };
  };
}
