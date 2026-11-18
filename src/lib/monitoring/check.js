import { createSafeDispatcher, assertPublicUrl } from "./ssrf.js";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_RESPONSE_BYTES = 64 * 1024;

export async function runCheck(monitor) {
  const startedAt = Date.now();
  const dispatcher = createSafeDispatcher();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    monitor.timeoutMs || 10000,
  );
  let target = monitor.url;

  try {
    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      const url = await assertPublicUrl(target, controller.signal);
      const response = await fetch(url, {
        method: monitor.method || "GET",
        headers: monitor.customHeaders || {},
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
        body: ["GET", "HEAD"].includes(monitor.method) ? undefined : "",
      });

      const location = response.headers.get("location");
      if (REDIRECT_CODES.has(response.status) && location) {
        if (redirectCount === 4) throw new Error("Too many redirects");
        target = new URL(location, url).toString();
        continue;
      }

      let contentMatches = true;
      if (monitor.expectedContent && monitor.method !== "HEAD") {
        contentMatches = await responseContains(
          response,
          monitor.expectedContent,
        );
      } else {
        await response.body?.cancel().catch(() => {});
      }

      const statusMatches = (monitor.expectedStatusCodes || [200]).includes(
        response.status,
      );
      const success = statusMatches && contentMatches;
      return {
        success,
        statusCode: response.status,
        responseTime: Date.now() - startedAt,
        error: success
          ? null
          : contentMatches
            ? `Unexpected HTTP ${response.status}`
            : "Expected content was not found",
      };
    }
  } catch (error) {
    return {
      success: false,
      statusCode: null,
      responseTime: Date.now() - startedAt,
      error:
        error.name === "AbortError"
          ? "Request timed out"
          : String(error.message).slice(0, 500),
    };
  } finally {
    clearTimeout(timeout);
    await dispatcher.close();
  }
}

async function responseContains(response, expected) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let content = "";
  let bytesRead = 0;

  try {
    while (bytesRead < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      content += decoder.decode(value, { stream: true });
      if (content.includes(expected)) return true;
    }
    return content.includes(expected);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
