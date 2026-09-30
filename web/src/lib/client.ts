"use client";

import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json: payload, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: payload !== undefined ? JSON.stringify(payload) : rest.body,
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && !(res.status === 403 && data && "decision" in data)) {
    throw new ApiError(res.status, (data && data.error) || res.statusText, data);
  }
  return data as T;
}

/** Tiny fetch hook: data, loading, error and a refetch you can call after mutations. */
export function useJson<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(url));
  const [tick, setTick] = useState(0);

  const refetch = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    api<T>(url)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, tick]);

  return { data, error, loading, refetch, setData };
}
