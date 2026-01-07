# CodeMeter - AI Coding Cost Tracker

**CodeMeter** provides **project-level cost tracking** for AI coding agents. It tracks your AI usage across projects, giving you clear insights into your AI spending across different workspaces.

## Features

- **Project-Level Costs**: Automatically tracks which project you are working on and attributes costs accordingly.
- **Local Cost Estimation**: Works in VS Code without any account - estimates AI costs based on detected interactions.
- **Budget Alerts**: Set monthly budgets per project and get notified when you're close to the limit.
- **Cross-IDE Support**: Works seamlessly across VS Code, Cursor, and other forks.
- **Dashboard**: Built-in Activity Bar dashboard to visualize daily/weekly costs and top models.
- **Optional Cursor Integration**: Connect your Cursor account for exact usage data (optional).

## How to Use

1. **Install**: Get CodeMeter from the VS Code Marketplace or Open VSX.
2. **Start Coding**: CodeMeter runs in the background and tracks AI interactions automatically.
3. **View Dashboard**: Open the **CodeMeter** tab in the Activity Bar to see your estimated costs.
4. **Set Budgets**: Use `CodeMeter: Set Project Monthly Budget` to set spending limits.

### Optional: Connect Cursor Account

For exact usage data from Cursor's API (instead of estimates):
- Open the **CodeMeter** tab in the Activity Bar.
- Click **Connect Cursor (Optional)**.
- *Enterprise Users*: You can also provide an Admin API Key via `CodeMeter: Set Cursor Admin API Key`.

## Support

For issues or feature requests, visit our [GitHub Repository](https://github.com/bhav09/codemeter).

---

*Note: CodeMeter runs locally on your machine. Cursor integration is optional - the extension works standalone with local cost estimation. When connected, it communicates directly with Cursor's APIs. Your tokens are stored securely in VS Code's SecretStorage.*
