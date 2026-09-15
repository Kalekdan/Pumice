# Pumice

Pumice is a small web app for browsing and editing an Obsidian vault stored in a GitHub repository.

## Requirements

- Node.js 22.12 or newer

## Features

- Sign in with GitHub
- Pick a repository to use as your vault, including private repositories
- Browse markdown pages with rendered formatting
- Follow regular markdown links and Obsidian-style `[[Wiki Links]]`
- Edit the raw markdown file and save it back to GitHub with a commit message like `Updated Page Name on Pumice`

## Setup

Pumice only needs secrets from the person deploying the app. End users do not need to create OAuth apps or set any environment variables; they just click **Log in with GitHub** and authorize access.

### One-time setup for the app owner

1. Create a GitHub OAuth app and set its callback URL to match `GITHUB_CALLBACK_URL` (or use `http://localhost:3000/auth/github/callback` if you keep the default).
2. Set these environment variables on the server running Pumice:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
   - `SESSION_SECRET`
   - `GITHUB_CALLBACK_URL` (optional, defaults to `http://localhost:3000/auth/github/callback`)
3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the app:

   ```bash
   npm start
   ```

Then open `http://localhost:3000`.

### What end users do

1. Open the Pumice site.
2. Click **Log in with GitHub**.
3. Approve GitHub access.
4. Select the repository that contains the vault.