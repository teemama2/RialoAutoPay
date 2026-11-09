
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppServer } from "../server.mjs";

let temporaryDirectory;
let server;
let baseUrl;

let upstreamHandler;
let upstreamCalls = [];

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

async function rpcRequest(payload, options = {}) {
  return request("/rialo-rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    body:
      options.body ??
      JSON.stringify(payload),
  });
}

before(async () => {
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), "rialoautopay-server-"),
  );

  await mkdir(
    join(temporaryDirectory, "assets"),
    { recursive: true },
  );

  await writeFile(
    join(temporaryDirectory, "index.html"),
    "<!doctype html><html><body>RialoAutoPay Test</body></html>",
  );

  await writeFile(
    join(temporaryDirectory, "assets", "app.js"),
    "console.log('RialoAutoPay');",
  );

  upstreamHandler = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: "ok",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

  server = createAppServer({
    distDir: temporaryDirectory,

    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url, options });
      return upstreamHandler(url, options);
    },
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  assert.ok(address && typeof address === "object");

  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  if (temporaryDirectory) {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("serves the production application entry point", async () => {
  const response = await request("/");

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/html/,
  );

  assert.equal(
    response.headers.get("cache-control"),
    "no-cache",
  );

  assert.match(
    await response.text(),
    /RialoAutoPay Test/,
  );

  assert.equal(
    response.headers.get("x-content-type-options"),
    "nosniff",
  );

  assert.equal(
    response.headers.get("x-frame-options"),
    "DENY",
  );
});

test("serves application assets with their correct MIME type", async () => {
  const response = await request("/assets/app.js");

  assert.equal(response.status, 200);

  assert.match(
    response.headers.get("content-type") ?? "",
    /javascript/,
  );

  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );

  assert.match(await response.text(), /RialoAutoPay/);
});

test("supports client-side application routes", async () => {
  const response = await request("/dashboard/activity");

  assert.equal(response.status, 200);
  assert.match(
    await response.text(),
    /RialoAutoPay Test/,
  );
});

test("returns 404 for missing static assets", async () => {
  const response = await request("/assets/missing.js");

  assert.equal(response.status, 404);

  const body = await response.json();

  assert.match(body.error, /not found/i);
});

test("provides a successful production health check", async () => {
  const response = await request("/healthz");

  assert.equal(response.status, 200);

  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "rialoautopay",
  });
});

test("rejects unsupported health-check methods", async () => {
  const response = await request("/healthz", {
    method: "POST",
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("forwards JSON-RPC requests to the Rialo HTTPS endpoint", async () => {
  const payload = {
    jsonrpc: "2.0",
    id: 22,
    method: "getHealth",
    params: [],
  };

  upstreamHandler = async (url, options) => {
    assert.equal(
      url,
      "https://devnet.rialo.io:4101/",
    );

    assert.equal(options.method, "POST");

    assert.equal(
      options.headers["Content-Type"],
      "application/json",
    );

    assert.deepEqual(
      JSON.parse(options.body),
      payload,
    );

    assert.ok(options.signal instanceof AbortSignal);

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 22,
        result: "healthy",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const response = await rpcRequest(payload);

  assert.equal(response.status, 200);

  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: 22,
    result: "healthy",
  });

  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
  );

  assert.ok(upstreamCalls.length > 0);
});

test("rejects GET requests to the RPC endpoint", async () => {
  const response = await request("/rialo-rpc");

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("rejects non-JSON RPC requests", async () => {
  const response = await request("/rialo-rpc", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
    },
    body: "invalid",
  });

  assert.equal(response.status, 415);
});

test("rejects empty RPC request bodies", async () => {
  const response = await request("/rialo-rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  assert.equal(response.status, 400);
});

test("rejects malformed JSON", async () => {
  const response = await rpcRequest(
    {},
    { body: '{"jsonrpc":' },
  );

  assert.equal(response.status, 400);
});

test("rejects invalid JSON-RPC request structures", async () => {
  const response = await rpcRequest({
    jsonrpc: "2.0",
    id: 30,
    params: [],
  });

  assert.equal(response.status, 400);

  const body = await response.json();

  assert.match(body.error, /invalid json-rpc/i);
});

test("passes upstream HTTP errors to the application", async () => {
  upstreamHandler = async () =>
    new Response(
      JSON.stringify({
        error: "Devnet temporarily unavailable.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

  const response = await rpcRequest({
    jsonrpc: "2.0",
    id: 31,
    method: "getHealth",
    params: [],
  });

  assert.equal(response.status, 503);

  const body = await response.json();

  assert.match(body.error, /temporarily unavailable/i);
});

test("converts upstream connection failures to HTTP 502", async () => {
  upstreamHandler = async () => {
    throw new TypeError("Connection refused.");
  };

  const response = await rpcRequest({
    jsonrpc: "2.0",
    id: 32,
    method: "getHealth",
    params: [],
  });

  assert.equal(response.status, 502);

  const body = await response.json();

  assert.equal(body.id, 32);

  assert.match(
    body.error.message,
    /Unable to reach Rialo Devnet RPC/,
  );
});

test("converts upstream timeouts to HTTP 504", async () => {
  upstreamHandler = async () => {
    const error = new Error("Request timed out.");
    error.name = "TimeoutError";
    throw error;
  };

  const response = await rpcRequest({
    jsonrpc: "2.0",
    id: 33,
    method: "getHealth",
    params: [],
  });

  assert.equal(response.status, 504);

  const body = await response.json();

  assert.equal(body.id, 33);

  assert.match(
    body.error.message,
    /timed out/i,
  );
});

test("rejects an insecure production RPC upstream", () => {
  assert.throws(
    () =>
      createAppServer({
        rpcUpstream: "http://example.com",
        fetchImpl: async () => new Response(""),
      }),
    /must be an HTTPS URL/,
  );
});

console.log("Production server test suite loaded.");
