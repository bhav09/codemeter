# Token accounting (short & friendly)

CodeMeter estimates and displays the cost of AI-generated code so you can budget and audit usage per project.

Why this matters
- Know which AI tools and models are driving cost.
- Track usage per project and avoid surprise bills.

What we count
- Only AI-generated output inserted into your files (completions, inline edits, chat outputs).
- We do NOT count IDE parsing or CodeMeter's own analysis.

How tokens are estimated (quick)
- Output tokens: estimated from characters (code ≈ 3.5 chars/token).
- Input tokens: estimated by interaction type (completion, inline-edit, chat) using conservative context estimates.

Pricing
- Model rates (input/output) are configurable in `packages/core/src/pricing.ts`.
- If the exact model is unknown, CodeMeter uses a reasonable default.

Batching & accuracy
- Changes within short time windows are grouped to represent one AI response.
- Estimates are conservative; exact tokenizers differ by model.

Storage & privacy
- Per-project storage: `<projectRoot>/.codemeter/` (fallback: `~/.codemeter`).
- Data is stored locally; source code is not uploaded.

Got feedback?
- Open an issue or PR at https://github.com/bhav09/codemeter

---

For detailed rules and examples see the original long-form docs in the repo.
