# Pumice

Pumice is a small web app for browsing and editing an Obsidian vault stored in a GitHub repository.

## Features

- Sign in with GitHub
- Pick a repository to use as your vault, including private repositories
- Browse markdown pages with rendered formatting
- Follow regular markdown links and Obsidian-style `[[Wiki Links]]`
- Edit the raw markdown file and save it back to GitHub with a commit message like `Updated Page Name on Pumice`

## Setup

1. Create a GitHub OAuth app.
2. Set these environment variables:
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