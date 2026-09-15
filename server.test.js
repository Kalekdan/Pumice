import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  app,
  buildFileTree,
  normalizeContentForSave,
  resolvePagePath,
  rewriteMarkdown,
  renderMarkdown,
  setOctokitFactory,
  resetOctokitFactory,
} =
  await import("./server.js");

test("resolvePagePath prefers README for the vault root", () => {
  const files = ["notes/Alpha.md", "README.md", "zeta.md"];

  assert.equal(resolvePagePath("", files), "README.md");
});

test("resolvePagePath can uniquely match a file by title across folders", () => {
  const files = ["daily/Journal.md", "notes/Linked Page.md", "other/Else.md"];

  assert.equal(resolvePagePath("Linked Page", files), "notes/Linked Page.md");
});

test("resolvePagePath does not guess when multiple files share the same title", () => {
  const files = ["notes/Linked Page.md", "archive/Linked Page.md"];

  assert.equal(resolvePagePath("Linked Page", files), null);
});

test("rewriteMarkdown rewrites wiki links and markdown links to vault routes", () => {
  const output = rewriteMarkdown(
    "[[Daily Note]] and [Sibling](sibling.md#section) and [Child](nested/child)",
    "notes/current.md",
  );

  assert.match(output, /\[Daily Note\]\(\/vault\/Daily%20Note\.md\)/);
  assert.match(output, /\[Sibling\]\(\/vault\/notes\/sibling\.md#section\)/);
  assert.match(output, /\[Child\]\(\/vault\/notes\/nested\/child\.md\)/);
});

test("rewriteMarkdown preserves wiki aliases, malformed links, and upward traversal", () => {
  const output = rewriteMarkdown(
    "[[Folder/Note|Alias]] [[Broken and [Parent](../parent.md)]",
    "notes/current.md",
  );

  assert.match(output, /\[Alias\]\(\/vault\/Folder\/Note\.md\)/);
  assert.match(output, /\[\[Broken/);
  assert.match(output, /\[Parent\]\(\.\.\/parent\.md\)/);
});

test("renderMarkdown preserves safe in-app vault links", () => {
  const html = renderMarkdown("[[Linked Page]]", "notes/current.md");

  assert.match(html, /href="\/vault\/Linked%20Page\.md"/);
});

test("normalizeContentForSave preserves the existing file line endings", () => {
  assert.equal(
    normalizeContentForSave("first\nsecond\nthird", "first\r\nsecond\r\nthird"),
    "first\r\nsecond\r\nthird",
  );
});

test("buildFileTree creates nested folders and marks current ancestors open", () => {
  const tree = buildFileTree(
    ["README.md", "notes/alpha.md", "notes/nested/beta.md"],
    "notes/nested/beta.md",
  );
  const notesFolder = tree.find((node) => node.type === "folder" && node.name === "notes");
  const nestedFolder = notesFolder.children.find(
    (node) => node.type === "folder" && node.name === "nested",
  );

  assert.equal(notesFolder.open, true);
  assert.equal(nestedFolder.open, true);
  assert.equal(nestedFolder.children[0].path, "notes/nested/beta.md");
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

test("repository selection persists the chosen repo in session", async () => {
  setOctokitFactory(() => ({
    paginate: async () => [],
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
      },
    },
  }));

  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const signInResponse = await fetch(`${baseUrl}/test/sign-in`, {
      headers: { host: `localhost:${address.port}` },
    });
    const cookie = signInResponse.headers.get("set-cookie").split(";", 1)[0];
    const { csrfToken } = await signInResponse.json();

    const selectResponse = await fetch(`${baseUrl}/repos/select`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: `localhost:${address.port}`,
      },
      body: new URLSearchParams({
        _csrf: csrfToken,
        repository: "Kalekdan/vault",
      }),
      redirect: "manual",
    });

    assert.equal(selectResponse.status, 302);
    assert.equal(selectResponse.headers.get("location"), "/vault");

    const sessionResponse = await fetch(`${baseUrl}/test/session`, {
      headers: {
        cookie,
        host: `localhost:${address.port}`,
      },
    });
    const sessionData = await sessionResponse.json();

    assert.deepEqual(sessionData.selectedRepo, {
      owner: "Kalekdan",
      repo: "vault",
      defaultBranch: "main",
    });
  } finally {
    resetOctokitFactory();
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

test("repository selection rejects invalid values", async () => {
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const signInResponse = await fetch(`${baseUrl}/test/sign-in`, {
      headers: { host: `localhost:${address.port}` },
    });
    const cookie = signInResponse.headers.get("set-cookie").split(";", 1)[0];
    const { csrfToken } = await signInResponse.json();

    const response = await fetch(`${baseUrl}/repos/select`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: `localhost:${address.port}`,
      },
      body: new URLSearchParams({
        _csrf: csrfToken,
        repository: "",
      }),
      redirect: "manual",
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/repos");
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

test("repository selection rejects malformed multi-segment values", async () => {
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const signInResponse = await fetch(`${baseUrl}/test/sign-in`, {
      headers: { host: `localhost:${address.port}` },
    });
    const cookie = signInResponse.headers.get("set-cookie").split(";", 1)[0];
    const { csrfToken } = await signInResponse.json();

    const response = await fetch(`${baseUrl}/repos/select`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: `localhost:${address.port}`,
      },
      body: new URLSearchParams({
        _csrf: csrfToken,
        repository: "Kalekdan/vault/extra",
      }),
      redirect: "manual",
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/repos");
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

test("repository selection shows an error when the GitHub lookup fails", async () => {
  setOctokitFactory(() => ({
    paginate: async () => [],
    rest: {
      repos: {
        get: async () => {
          throw new Error("GitHub lookup failed");
        },
      },
    },
  }));

  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const signInResponse = await fetch(`${baseUrl}/test/sign-in`, {
      headers: { host: `localhost:${address.port}` },
    });
    const cookie = signInResponse.headers.get("set-cookie").split(";", 1)[0];
    const { csrfToken } = await signInResponse.json();

    const response = await fetch(`${baseUrl}/repos/select`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: `localhost:${address.port}`,
      },
      body: new URLSearchParams({
        _csrf: csrfToken,
        repository: "Kalekdan/vault",
      }),
    });
    const html = await response.text();

    assert.equal(response.status, 500);
    assert.match(html, /Something went wrong while processing your request/);
  } finally {
    resetOctokitFactory();
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

test("repository list renders paginated results", async () => {
  setOctokitFactory(() => ({
    paginate: async () => [
      {
        owner: { login: "Kalekdan" },
        name: "vault-one",
        full_name: "Kalekdan/vault-one",
        private: true,
      },
      {
        owner: { login: "Kalekdan" },
        name: "vault-two",
        full_name: "Kalekdan/vault-two",
        private: false,
      },
    ],
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
      },
    },
  }));

  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const signInResponse = await fetch(`${baseUrl}/test/sign-in`, {
      headers: { host: `localhost:${address.port}` },
    });
    const cookie = signInResponse.headers.get("set-cookie").split(";", 1)[0];

    const response = await fetch(`${baseUrl}/repos`, {
      headers: {
        cookie,
        host: `localhost:${address.port}`,
      },
    });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Kalekdan\/vault-one/);
    assert.match(html, /Kalekdan\/vault-two/);
    assert.match(html, /Available repositories/);
  } finally {
    resetOctokitFactory();
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
