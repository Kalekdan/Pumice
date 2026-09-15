import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { app, resolvePagePath, rewriteMarkdown } = await import("./server.js");

test("resolvePagePath prefers README for the vault root", () => {
  const files = ["notes/Alpha.md", "README.md", "zeta.md"];

  assert.equal(resolvePagePath("", files), "README.md");
});

test("rewriteMarkdown rewrites wiki links and markdown links to vault routes", () => {
  const output = rewriteMarkdown(
    "[[Daily Note]] and [Sibling](sibling.md) and [Child](nested/child)",
    "notes/current.md",
  );

  assert.match(output, /\[Daily Note\]\(\/vault\/Daily%20Note\.md\)/);
  assert.match(output, /\[Sibling\]\(\/vault\/notes\/sibling\.md\)/);
  assert.match(output, /\[Child\]\(\/vault\/notes\/nested\/child\.md\)/);
});

test("home page renders successfully without GitHub credentials", async () => {
  const server = app.listen(0);
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: { host: `localhost:${address.port}` },
    });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Pumice/);
    assert.match(html, /Log in with GitHub/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
});
