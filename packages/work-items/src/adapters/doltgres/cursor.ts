// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Opaque keyset cursor for the Doltgres work-items read model.
 */

export class InvalidCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}
export type WorkItemCursor = {
  p: number | null;
  r: number | null;
  ts: string;
  id: string;
};

export function encodeCursor(cursor: WorkItemCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): WorkItemCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("p" in parsed) ||
    !("r" in parsed) ||
    !("ts" in parsed) ||
    !("id" in parsed)
  ) {
    throw new InvalidCursorError();
  }

  const value = parsed as Record<string, unknown>;
  const p = value.p === null ? null : value.p;
  const r = value.r === null ? null : value.r;
  if (p !== null && (!Number.isInteger(p) || Number(p) < 0)) {
    throw new InvalidCursorError();
  }
  if (r !== null && (!Number.isInteger(r) || Number(r) < 0)) {
    throw new InvalidCursorError();
  }
  if (typeof value.ts !== "string") throw new InvalidCursorError();
  const timestamp = new Date(value.ts);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString() !== value.ts
  ) {
    throw new InvalidCursorError();
  }
  if (
    typeof value.id !== "string" ||
    !/^(task|bug|story|spike|subtask)\.\d+$/.test(value.id)
  ) {
    throw new InvalidCursorError();
  }

  return {
    p: p as number | null,
    r: r as number | null,
    ts: value.ts,
    id: value.id,
  };
}
