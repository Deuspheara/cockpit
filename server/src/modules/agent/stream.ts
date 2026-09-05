import { AppError } from "../../shared/errors.js";

export interface SSEFrame {
  event: string;
  data: string;
  id?: string;
}
/** Incremental SSE framing. UTF-8 decoding belongs to the byte reader. */
export class SSEParser {
  private buffer = "";
  private data: string[] = [];
  private event = "message";
  private id: string | undefined;
  feed(text: string): SSEFrame[] {
    this.buffer += text;
    if (this.buffer.length > 1_000_000)
      throw new AppError(
        "AI_INVALID_RESPONSE",
        "The model stream exceeded its frame limit",
        502,
      );
    const frames: SSEFrame[] = [];
    while (true) {
      const match = /[\r\n]/.exec(this.buffer);
      if (
        !match ||
        (match[0] === "\r" && match.index === this.buffer.length - 1)
      )
        break;
      const line = this.buffer.slice(0, match.index);
      const size =
        this.buffer.slice(match.index, match.index + 2) === "\r\n" ? 2 : 1;
      this.buffer = this.buffer.slice(match.index + size);
      if (!line) {
        if (this.data.length)
          frames.push({
            event: this.event,
            data: this.data.join("\n"),
            id: this.id,
          });
        this.data = [];
        this.event = "message";
      } else if (!line.startsWith(":")) {
        const split = line.indexOf(":");
        const field = split < 0 ? line : line.slice(0, split);
        const value = split < 0 ? "" : line.slice(split + 1).replace(/^ /, "");
        if (field === "data") this.data.push(value);
        if (field === "event") this.event = value;
        if (field === "id" && !value.includes("\0")) this.id = value;
        if (this.data.join("").length > 1_000_000)
          throw new AppError(
            "AI_INVALID_RESPONSE",
            "The model stream exceeded its frame limit",
            502,
          );
      }
    }
    return frames;
  }
}

export function aiError(
  status: number,
  body?: unknown,
  retryAfter?: string | null,
): AppError {
  const raw =
    body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : body;
  const message =
    raw && typeof raw === "object" && "message" in raw
      ? String(raw.message)
      : "";
  const unsupported =
    status === 400 ||
    (status === 404 && /parameter|tool|schema/i.test(message));
  const [code, safe, retryable] =
    status === 401 || status === 403
      ? [
          "AI_AUTHENTICATION",
          "OpenRouter rejected the server credentials or access policy. Check the server API key and provider permissions.",
          false,
        ]
      : status === 402
        ? [
            "AI_CREDITS",
            "OpenRouter credits are insufficient. Add credits or check the key spending limit.",
            false,
          ]
        : unsupported
          ? [
              "AI_UNSUPPORTED_PARAMETERS",
              "No compatible model endpoint accepted the required parameters. Check model tool/schema support and OpenRouter provider restrictions.",
              false,
            ]
          : status === 404
            ? [
                "AI_MODEL_UNAVAILABLE",
                "The configured model has no available endpoint. Check its model ID and provider restrictions.",
                false,
              ]
            : status === 429
              ? [
                  "AI_RATE_LIMIT",
                  "OpenRouter is rate limiting requests. Wait briefly before retrying.",
                  true,
                ]
              : status === 408 || status === 504
                ? [
                    "AI_TIMEOUT",
                    "The model took too long to respond. Your saved text and proposals remain available; retry when ready.",
                    true,
                  ]
                : [
                    "AI_PROVIDER_FAILURE",
                    "The model provider could not finish the response. Your saved text and proposals remain available; retry when ready.",
                    true,
                  ];
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  return new AppError(
    String(code),
    String(safe),
    status === 429 ? 429 : status === 408 || status === 504 ? 504 : 502,
    {
      retryable,
      upstreamStatus: status,
      ...(Number.isFinite(seconds)
        ? { retryAfterSeconds: Math.max(1, Math.min(300, seconds)) }
        : {}),
    },
  );
}
export function publicError(error: unknown) {
  const safe = error instanceof AppError ? error : aiError(502);
  return {
    code: safe.code,
    message: safe.message,
    ...(safe.details as object),
  };
}
