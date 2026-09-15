import express from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Octokit } from "octokit";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  SESSION_SECRET = "development-session-secret",
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_CALLBACK_URL,
} = process.env;

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  }),
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

if (GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
        callbackURL:
          GITHUB_CALLBACK_URL || "http://localhost:3000/auth/github/callback",
        scope: ["read:user", "repo"],
        passReqToCallback: true,
      },
      async (req, accessToken, _refreshToken, profile, done) => {
        req.session.accessToken = accessToken;
        done(null, {
          id: profile.id,
          username: profile.username,
          displayName: profile.displayName || profile.username,
        });
      },
    ),
  );
}

app.use(passport.initialize());
app.use(passport.session());

marked.setOptions({
  breaks: true,
  gfm: true,
});

const rateLimitState = new Map();

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "anonymous";
    const now = Date.now();
    const existing = rateLimitState.get(key);

    if (!existing || existing.resetAt <= now) {
      rateLimitState.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (existing.count >= max) {
      return res.status(429).render("error", {
        message: "Too many requests. Please try again shortly.",
      });
    }

    existing.count += 1;
    return next();
  };
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString("hex");
}

function csrfTokenFor(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = createCsrfToken();
  }

  return req.session.csrfToken;
}

app.use(rateLimit({ windowMs: 60_000, max: 180 }));
app.use((req, res, next) => {
  res.locals.csrfToken = csrfTokenFor(req);
  next();
});
app.use((req, res, next) => {
  if (req.method !== "POST") {
    return next();
  }

  if (req.body._csrf !== req.session.csrfToken) {
    return res.status(403).render("error", {
      message: "Invalid CSRF token.",
    });
  }

  req.session.csrfToken = createCsrfToken();
  res.locals.csrfToken = req.session.csrfToken;
  return next();
});

function encodeVaultPath(filePath = "") {
  return filePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function toVaultUrl(filePath = "") {
  return `/vault/${encodeVaultPath(filePath)}`;
}

function toEditUrl(filePath = "") {
  return `/edit/${encodeVaultPath(filePath)}`;
}

function titleFromPath(filePath = "") {
  return path.posix.basename(filePath, path.posix.extname(filePath)) || "Vault";
}

function normalizeRequestedPath(requestedPath = "") {
  let normalizedPath = requestedPath
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");

  while (normalizedPath.startsWith("/")) {
    normalizedPath = normalizedPath.slice(1);
  }

  while (normalizedPath.endsWith("/")) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  return normalizedPath;
}

function rewriteWikiLinks(content) {
  let rewritten = "";

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "[" || content[index + 1] !== "[") {
      rewritten += content[index];
      continue;
    }

    const closingIndex = content.indexOf("]]", index + 2);

    if (closingIndex === -1) {
      rewritten += content[index];
      continue;
    }

    const rawTarget = content.slice(index + 2, closingIndex);
    const [target, alias] = rawTarget.split("|");
    const trimmedTarget = target.trim();
    const label = (alias || titleFromPath(trimmedTarget)).trim();
    const normalizedTarget = path.posix.extname(trimmedTarget)
      ? trimmedTarget
      : `${trimmedTarget}.md`;

    rewritten += `[${label}](${toVaultUrl(normalizedTarget)})`;
    index = closingIndex + 1;
  }

  return rewritten;
}

function relativeMarkdownTarget(target, currentPath) {
  const [rawPath, rawHash = ""] = target.split("#");
  const basePath = rawPath.trim();

  if (!basePath || /^[a-z]+:/i.test(basePath) || basePath.startsWith("#")) {
    return target;
  }

  const resolved = path.posix.normalize(
    basePath.startsWith("/")
      ? basePath.slice(1)
      : path.posix.join(path.posix.dirname(currentPath), basePath),
  );

  const withExtension = path.posix.extname(resolved) ? resolved : `${resolved}.md`;
  const suffix = rawHash ? `#${rawHash}` : "";

  return `${toVaultUrl(withExtension)}${suffix}`;
}

function rewriteMarkdown(content, currentPath) {
  const wikiLinked = rewriteWikiLinks(content);

  return wikiLinked.replace(
    /(!)?\[([^\]]+)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (match, imagePrefix, label, rawHref) => {
      if (imagePrefix) {
        return match;
      }

      const href = rawHref.trim().replace(/^<|>$/g, "");
      const hrefPath = href.split("#")[0];

      if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("/")) {
        return match;
      }

      if (path.posix.extname(hrefPath) === ".md" || !path.posix.extname(hrefPath)) {
        return `[${label}](${relativeMarkdownTarget(href, currentPath)})`;
      }

      return match;
    },
  );
}

function renderMarkdown(content, currentPath) {
  return sanitizeHtml(marked.parse(rewriteMarkdown(content, currentPath)), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "h1",
      "h2",
      "img",
      "input",
    ]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      input: ["type", "checked", "disabled"],
    },
  });
}

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  return res.redirect("/");
}

function selectedRepoFrom(req) {
  return req.session.selectedRepo;
}

function createOctokit(req) {
  return new Octokit({ auth: req.session.accessToken });
}

async function listMarkdownFiles(req) {
  const selectedRepo = selectedRepoFrom(req);

  if (!selectedRepo) {
    return [];
  }

  const octokit = createOctokit(req);
  const branchResponse = await octokit.rest.repos.getBranch({
    owner: selectedRepo.owner,
    repo: selectedRepo.repo,
    branch: selectedRepo.defaultBranch,
  });
  const treeResponse = await octokit.rest.git.getTree({
    owner: selectedRepo.owner,
    repo: selectedRepo.repo,
    tree_sha: branchResponse.data.commit.commit.tree.sha,
    recursive: "1",
  });

  return treeResponse.data.tree
    .filter((item) => item.type === "blob" && /\.md$/i.test(item.path))
    .map((item) => item.path)
    .sort((left, right) => left.localeCompare(right));
}

function resolvePagePath(requestedPath, markdownFiles) {
  if (!markdownFiles.length) {
    return null;
  }

  const normalizedRequestedPath = normalizeRequestedPath(requestedPath);
  const byLowercase = new Map(markdownFiles.map((filePath) => [filePath.toLowerCase(), filePath]));

  if (!normalizedRequestedPath) {
    return (
      byLowercase.get("readme.md") ||
      byLowercase.get("README.md".toLowerCase()) ||
      markdownFiles[0]
    );
  }

  const candidates = new Set([normalizedRequestedPath]);

  if (!path.posix.extname(normalizedRequestedPath)) {
    candidates.add(`${normalizedRequestedPath}.md`);
  }

  for (const candidate of candidates) {
    const exactMatch = byLowercase.get(candidate.toLowerCase());

    if (exactMatch) {
      return exactMatch;
    }
  }

  return null;
}

async function readFileContent(req, filePath) {
  const selectedRepo = selectedRepoFrom(req);
  const octokit = createOctokit(req);
  const response = await octokit.rest.repos.getContent({
    owner: selectedRepo.owner,
    repo: selectedRepo.repo,
    path: filePath,
    ref: selectedRepo.defaultBranch,
  });

  if (!("content" in response.data)) {
    throw new Error(`Unable to read file at ${filePath}`);
  }

  return {
    sha: response.data.sha,
    content: Buffer.from(response.data.content, "base64").toString("utf8"),
  };
}

async function renderPage(req, res, requestedPath = "") {
  const markdownFiles = await listMarkdownFiles(req);
  const pagePath = resolvePagePath(requestedPath, markdownFiles);

  if (!pagePath) {
    return res.status(404).render("page", {
      pageTitle: "Vault",
      bodyHtml: "<p>No markdown pages were found in this repository.</p>",
      currentPath: "",
      repo: selectedRepoFrom(req),
      files: markdownFiles,
    });
  }

  const { content } = await readFileContent(req, pagePath);

  return res.render("page", {
    pageTitle: titleFromPath(pagePath),
    bodyHtml: renderMarkdown(content, pagePath),
    currentPath: pagePath,
    repo: selectedRepoFrom(req),
    files: markdownFiles,
  });
}

app.get("/", (req, res) => {
  res.render("home", {
    isAuthenticated: req.isAuthenticated(),
    authConfigured: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
    selectedRepo: selectedRepoFrom(req),
    user: req.user,
  });
});

app.get("/auth/github", (req, res, next) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.status(500).render("home", {
      isAuthenticated: false,
      authConfigured: false,
      selectedRepo: null,
      user: null,
    });
  }

  return passport.authenticate("github")(req, res, next);
});

app.get(
  "/auth/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  (_req, res) => res.redirect("/repos"),
);

app.post("/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) {
      return next(error);
    }

    req.session.destroy(() => {
      res.redirect("/");
    });

    return undefined;
  });
});

app.get("/repos", ensureAuthenticated, async (req, res, next) => {
  try {
    const octokit = createOctokit(req);
    const reposResponse = await octokit.rest.repos.listForAuthenticatedUser({
      affiliation: "owner,collaborator",
      per_page: 100,
      sort: "updated",
    });

    res.render("repos", {
      repos: reposResponse.data,
      selectedRepo: selectedRepoFrom(req),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/repos/select", ensureAuthenticated, async (req, res, next) => {
  try {
    const [owner, repo] = (req.body.repository || "").split("/");

    if (!owner || !repo) {
      return res.redirect("/repos");
    }

    const octokit = createOctokit(req);
    const repoResponse = await octokit.rest.repos.get({ owner, repo });

    req.session.selectedRepo = {
      owner,
      repo,
      defaultBranch: repoResponse.data.default_branch,
    };

    return res.redirect("/vault");
  } catch (error) {
    return next(error);
  }
});

app.get("/vault", ensureAuthenticated, async (req, res, next) => {
  try {
    if (!selectedRepoFrom(req)) {
      return res.redirect("/repos");
    }

    return await renderPage(req, res);
  } catch (error) {
    return next(error);
  }
});

app.get(/^\/vault\/(.*)$/, ensureAuthenticated, async (req, res, next) => {
  try {
    if (!selectedRepoFrom(req)) {
      return res.redirect("/repos");
    }

    return await renderPage(req, res, req.params[0]);
  } catch (error) {
    return next(error);
  }
});

app.get(/^\/edit\/(.*)$/, ensureAuthenticated, async (req, res, next) => {
  try {
    if (!selectedRepoFrom(req)) {
      return res.redirect("/repos");
    }

    const markdownFiles = await listMarkdownFiles(req);
    const pagePath = resolvePagePath(req.params[0], markdownFiles);

    if (!pagePath) {
      return res.status(404).redirect("/vault");
    }

    const { content } = await readFileContent(req, pagePath);

    return res.render("edit", {
      pageTitle: titleFromPath(pagePath),
      currentPath: pagePath,
      fileContent: content,
      repo: selectedRepoFrom(req),
    });
  } catch (error) {
    return next(error);
  }
});

app.post(/^\/edit\/(.*)$/, ensureAuthenticated, async (req, res, next) => {
  try {
    if (!selectedRepoFrom(req)) {
      return res.redirect("/repos");
    }

    const markdownFiles = await listMarkdownFiles(req);
    const pagePath = resolvePagePath(req.params[0], markdownFiles);

    if (!pagePath) {
      return res.status(404).redirect("/vault");
    }

    const selectedRepo = selectedRepoFrom(req);
    const octokit = createOctokit(req);
    const { sha } = await readFileContent(req, pagePath);

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: selectedRepo.owner,
      repo: selectedRepo.repo,
      branch: selectedRepo.defaultBranch,
      path: pagePath,
      message: `Updated ${titleFromPath(pagePath)} on Pumice`,
      content: Buffer.from(req.body.content || "", "utf8").toString("base64"),
      sha,
    });

    return res.redirect(toVaultUrl(pagePath));
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  res.status(500).render("error", {
    message: error.message || "Unexpected error",
  });
});

export { app, renderMarkdown, resolvePagePath, rewriteMarkdown };

export function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`Pumice listening on http://localhost:${port}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}
