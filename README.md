# CodeMeter — Track AI-generated code & estimate its cost

CodeMeter gives you fast, local-first insight into how much AI assistance costs while you code.

Why it matters
- Track AI usage per project so you can see which tools and models are driving cost.
- Helpful for individuals and teams to budget and audit AI-assisted development.

What it does
- Detects AI-generated insertions (completions, inline edits, chat outputs).
- Estimates tokens from inserted characters and converts tokens → cost using model pricing.
- Stores usage per-project (`.codemeter`), supports multi-root workspaces, and offers a dashboard.

Quick start
1. Install the extension in VS Code.
2. Open a project folder and open the CodeMeter Dashboard view.
3. Optionally set `codemeter.codemeterPath` in workspace settings to customize storage.

Privacy
- CodeMeter stores only estimated token counts and metadata locally. It does NOT upload your source code.

Learn more
- Detailed token accounting: `TOKEN_ACCOUNTING.md`

Feedback & Contribution
- Issues and PRs: https://github.com/bhav09/codemeter
