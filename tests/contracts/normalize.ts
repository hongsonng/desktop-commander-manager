export function normalizeContractValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    // ISO timestamps
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value)) {
      return "[TIMESTAMP]";
    }
    // URLs with ephemeral ports
    return value.replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:[PORT]");
  }

  if (Array.isArray(value)) {
    return value.map(normalizeContractValue);
  }

  if (typeof value === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "pid" && typeof v === "number") {
        res[k] = "[PID]";
      } else if (k === "uptimeMs" && typeof v === "number") {
        res[k] = "[UPTIME_MS]";
      } else if (
        (k === "startedAt" ||
          k === "createdAt" ||
          k === "updatedAt" ||
          k === "lastHeartbeatAt" ||
          k === "sampledAt") &&
        typeof v === "string"
      ) {
        res[k] = "[TIMESTAMP]";
      } else {
        res[k] = normalizeContractValue(v);
      }
    }
    return res;
  }

  return value;
}
