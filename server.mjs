
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = fileURLToPath(
  new URL(".", import.meta.url),
);

const DEFAULT_DIST_DIR = resolve(PROJECT_ROOT, "dist");
const DEFAULT_RPC_UPSTREAM = "https://devnet.rialo.io:4101";

const RPC_TIMEOUT_MS = 20_000;
const MAX_RPC_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) {
    return;
  }

  response.statusCode = status;
  response.setHeader(
    "Content-Type",
    "application/json; charset=utf-8",
  );
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin",
  );
}

async function readRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    totalBytes += buffer.length;

    if (totalBytes > MAX_RPC_BODY_BYTES) {
      throw new HttpError(
        413,
        "RPC request body exceeds the 1 MB limit.",
      );
    }

    chunks.push(buffer);
  }

  if (totalBytes === 0) {
    throw new HttpError(400, "RPC request body is empty.");
  }

  return Buffer.concat(chunks);
}

async function proxyRpc(
  request,
  response,
  rpcUpstream,
  fetchImpl,
) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, {
      error: "Only POST is supported for Rialo RPC.",
    });
    return;
  }

  const contentType = String(
    request.headers["content-type"] ?? "",
  ).toLowerCase();

  if (!contentType.includes("application/json")) {
    sendJson(response, 415, {
      error: "RPC requests must use application/json.",
    });
    return;
  }

  let body;
  let rpcRequest;

  try {
    body = await readRequestBody(request);
    rpcRequest = JSON.parse(body.toString("utf8"));
  } catch (cause) {
    const status =
      cause instanceof HttpError ? cause.status : 400;

    sendJson(response, status, {
      error:
        cause instanceof Error
          ? cause.message
          : "Invalid RPC request.",
    });
    return;
  }

  const calls = Array.isArray(rpcRequest)
    ? rpcRequest
    : [rpcRequest];

  if (
    calls.length === 0 ||
    calls.some(
      (call) =>
        typeof call !== "object" ||
        call === null ||
        typeof call.method !== "string",
    )
  ) {
    sendJson(response, 400, {
      error: "Invalid JSON-RPC request.",
    });
    return;
  }

  try {
    const upstreamResponse = await fetchImpl(rpcUpstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });

    const upstreamBody = await upstreamResponse.text();

    response.statusCode = upstreamResponse.status;
    response.setHeader(
      "Content-Type",
      upstreamResponse.headers.get("content-type") ??
        "application/json",
    );
    response.setHeader("Cache-Control", "no-store");
    response.end(upstreamBody);
  } catch (cause) {
    const timedOut =
      cause instanceof Error &&
      (cause.name === "TimeoutError" ||
        cause.name === "AbortError");

    sendJson(response, timedOut ? 504 : 502, {
      jsonrpc: "2.0",
      id: Array.isArray(rpcRequest)
        ? null
        : rpcRequest.id ?? null,
      error: {
        code: -32000,
        message: timedOut
          ? "Rialo Devnet RPC upstream timed out."
          : "Unable to reach Rialo Devnet RPC.",
      },
    });
  }
}

async function serveStatic(request, response, distDir) {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost")
        .pathname,
    );
  } catch {
    sendJson(response, 400, {
      error: "Invalid request path.",
    });
    return;
  }

  const relativePath =
    pathname === "/"
      ? "index.html"
      : pathname.replace(/^\/+/, "");

  const root = resolve(distDir);
  let filePath = resolve(root, relativePath);

  if (
    filePath !== root &&
    !filePath.startsWith(root + sep)
  ) {
    sendJson(response, 403, {
      error: "Access to this path is not allowed.",
    });
    return;
  }

  let fileInfo;

  try {
    fileInfo = await stat(filePath);

    if (!fileInfo.isFile()) {
      throw new Error("Not a file.");
    }
  } catch {
    // Return the React entry point for client-side routes.
    // Missing files with extensions remain genuine 404 responses.
    if (extname(relativePath)) {
      sendJson(response, 404, {
        error: "File not found.",
      });
      return;
    }

    filePath = resolve(root, "index.html");

    try {
      fileInfo = await stat(filePath);

      if (!fileInfo.isFile()) {
        throw new Error("Build entry point is missing.");
      }
    } catch {
      sendJson(response, 503, {
        error: "Production build not found. Run npm run build.",
      });
      return;
    }
  }

  try {
    const content = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();

    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      MIME_TYPES[extension] ?? "application/octet-stream",
    );

    response.setHeader(
      "Cache-Control",
      filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    );

    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    sendJson(response, 500, {
      error: "Unable to read the requested application file.",
    });
  }
}

export function createAppServer({
  distDir = DEFAULT_DIST_DIR,
  rpcUpstream =
    process.env.RIALO_RPC_UPSTREAM || DEFAULT_RPC_UPSTREAM,
  fetchImpl = globalThis.fetch,
} = {}) {
  const upstreamUrl = new URL(rpcUpstream);

  if (
    upstreamUrl.protocol !== "https:" ||
    upstreamUrl.username ||
    upstreamUrl.password
  ) {
    throw new Error(
      "RIALO_RPC_UPSTREAM must be an HTTPS URL without embedded credentials.",
    );
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required.");
  }

  return createServer((request, response) => {
    setSecurityHeaders(response);

    let pathname;

    try {
      pathname = new URL(
        request.url ?? "/",
        "http://localhost",
      ).pathname;
    } catch {
      sendJson(response, 400, {
        error: "Invalid request URL.",
      });
      return;
    }

    if (pathname === "/healthz") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, {
          error: "Only GET is supported for health checks.",
        });
        return;
      }

      stat(resolve(distDir, "index.html"))
        .then((fileInfo) => {
          if (!fileInfo.isFile()) {
            throw new Error("Build entry point is missing.");
          }

          sendJson(response, 200, {
            status: "ok",
            service: "rialoautopay",
          });
        })
        .catch(() => {
          sendJson(response, 503, {
            status: "unavailable",
            error: "Production build not found.",
          });
        });

      return;
    }

    if (pathname === "/rialo-rpc") {
      void proxyRpc(
        request,
        response,
        upstreamUrl.toString(),
        fetchImpl,
      );
      return;
    }

    if (
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, {
        error: "Method not allowed.",
      });
      return;
    }

    void serveStatic(request, response, resolve(distDir));
  });
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }

  const server = createAppServer();

  server.listen(port, host, () => {
    console.log(`RialoAutoPay listening on ${host}:${port}`);
    console.log("Rialo RPC proxy is available at /rialo-rpc");
    console.log("Health check is available at /healthz");
  });
}
