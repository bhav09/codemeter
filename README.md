# CodeMeter - AI Coding Cost Tracker

**CodeMeter** provides **project-level cost tracking** for AI coding agents. It attributes your Cursor usage to specific projects, giving you clear insights into your AI spending across different workspaces.

## Features

- **Project-Level Costs**: Automatically tracks which project you are working on and attributes costs accordingly.
- **Budget Alerts**: Set monthly budgets per project and get notified when you're close to the limit.
- **Cross-IDE Support**: Works seamlessly across VS Code, Cursor, and other forks.
- **Dashboard**: Built-in Activity Bar dashboard to visualize daily/weekly costs and top models.

## How to cleaning

1. **Install**: Get CodeMeter from the VS Code Marketplace or Open VSX.
2. **Connect Account**:
   - Open the **CodeMeter** tab in the Activity Bar.
   - Click **Connect Cursor** (uses your existing browser session).
   - *Enterprise Users*: You can also provide an Admin API Key via the command `CodeMeter: Set Cursor Admin API Key`.
3. **Start Coding**: CodeMeter runs in the background. Check the dashboard anytime to see your usage.

## Support

For issues or feature requests, visit our [GitHub Repository](https://github.com/bhav09/codemeter).

---

*Note: CodeMeter runs locally on your machine and communicates directly with Cursor's APIs. Your tokens are stored securely in VS Code's SecretStorage.*
