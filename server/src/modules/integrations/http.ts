import { AppError } from "../../shared/errors.js";
export type Fetch = typeof fetch;
export async function providerJSON(
  url: string,
  body: unknown | undefined,
  transport: Fetch = fetch,
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await transport(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      if (!response.ok)
        throw new AppError(
          "PROVIDER_ERROR",
          `Provider returned HTTP ${response.status}`,
          502,
        );
      return await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (attempt === 2)
        throw new AppError(
          "PROVIDER_ERROR",
          "Provider request failed or timed out",
          502,
        );
    }
  }
  throw new AppError("PROVIDER_ERROR", "Provider unavailable", 502);
}
