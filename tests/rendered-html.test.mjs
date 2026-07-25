import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders PuzzleArena shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>PuzzleArena<\/title>/i);
  assert.match(html, /Live chess puzzle battle/);
  assert.doesNotMatch(html, /ChatGPT|signin|sign-in|Dispatch-Owned/i);
});

test("project docs do not contain starter auth copy", async () => {
  const [readme, page] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /Polars/i);
  assert.match(page, /lichess-pack\.json/);
  assert.doesNotMatch(`${readme}\n${page}`, /ChatGPT|signin|sign-in|Dispatch-Owned/i);
});
