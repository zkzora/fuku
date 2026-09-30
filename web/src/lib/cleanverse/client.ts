import { randomUUID } from "node:crypto";
import { ENVELOPE_OK } from "./codes";
import { decryptPayload, encryptedEnvelope } from "./crypto";

/**
 * HTTP client for the Cleanverse cooperate API. Paths, headers and the envelope format are the
 * only Cleanverse wire literals in the app; correcting them after the invite touches this folder.
 */
export const DEFAULT_BASE_URL = "https://uatapi.cleanverse.com/api/cooperate";

export interface CleanverseClientConfig {
  baseUrl: string;
  apiId: string;
  apiKey: string;
  timeoutMs: number;
}

export interface CleanverseEnvelope<T> {
  code: string;
  message: string;
  data: T | null;
}

export interface CleanverseResponse<T> {
  data: T | null;
  message: string;
  requestId: string;
}

export class CleanverseError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "CleanverseError";
  }
}
export class CleanverseHttpError extends CleanverseError {
  constructor(
    message: string,
    readonly status: number,
    requestId: string,
  ) {
    super(message, requestId);
    this.name = "CleanverseHttpError";
  }
}
export class CleanverseBusinessError extends CleanverseError {
  constructor(
    message: string,
    readonly code: string,
    requestId: string,
    readonly providerData: unknown,
  ) {
    super(message, requestId);
    this.name = "CleanverseBusinessError";
  }
}
export class CleanverseTimeoutError extends CleanverseError {
  constructor(path: string, timeoutMs: number, requestId: string) {
    super(`Cleanverse ${path} timed out after ${timeoutMs} ms`, requestId);
    this.name = "CleanverseTimeoutError";
  }
}

export function cleanverseConfigFromEnv(env: Record<string, string | undefined> = process.env): CleanverseClientConfig | null {
  const apiId = env.CLEANVERSE_API_ID?.trim();
  const apiKey = env.CLEANVERSE_API_KEY?.trim();
  if (!apiId || !apiKey) return null;
  const timeoutMs = Number(env.CLEANVERSE_REQUEST_TIMEOUT_MS ?? 8000);
  return {
    baseUrl: (env.CLEANVERSE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiId,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000,
  };
}

export class CleanverseClient {
  constructor(
    readonly config: CleanverseClientConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** POST `path` and unwrap the `{code, message, data}` envelope. Throws on anything but "0000". */
  async post<T>(path: string, body: unknown, opts: { encrypted?: boolean } = {}): Promise<CleanverseResponse<T>> {
    const requestId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const url = `${this.config.baseUrl}/${path.replace(/^\/+/, "")}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-id": this.config.apiId,
          "X-Request-ID": requestId,
        },
        body: JSON.stringify(opts.encrypted ? encryptedEnvelope(body, this.config.apiKey) : body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new CleanverseTimeoutError(path, this.config.timeoutMs, requestId);
      throw new CleanverseError(`Cleanverse ${path} request failed: ${(err as Error).message}`, requestId);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new CleanverseHttpError(`Cleanverse ${path} returned HTTP ${res.status}`, res.status, requestId);
    let envelope: CleanverseEnvelope<unknown>;
    try {
      envelope = (await res.json()) as CleanverseEnvelope<unknown>;
    } catch {
      throw new CleanverseHttpError(`Cleanverse ${path} returned invalid JSON`, res.status, requestId);
    }
    if (!envelope || typeof envelope.code !== "string") {
      throw new CleanverseHttpError(`Cleanverse ${path} returned an invalid envelope`, res.status, requestId);
    }
    if (envelope.code !== ENVELOPE_OK) {
      throw new CleanverseBusinessError(envelope.message || `Cleanverse ${path} failed`, envelope.code, requestId, envelope.data);
    }
    return { data: this.decodeData<T>(envelope.data, path, requestId), message: envelope.message ?? "", requestId };
  }

  /** `data` may arrive as an encrypted base64 string; decrypt it when it is not already JSON. */
  private decodeData<T>(data: unknown, path: string, requestId: string): T | null {
    if (data === null || data === undefined) return null;
    if (typeof data !== "string") return data as T;
    const trimmed = data.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as T;
    try {
      return JSON.parse(decryptPayload(trimmed, this.config.apiKey)) as T;
    } catch {
      throw new CleanverseError(`Cleanverse ${path} returned data that could not be decrypted`, requestId);
    }
  }
}
