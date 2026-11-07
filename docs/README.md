# Pixelworld docs

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | The target architecture: grid, coordinate spaces, geo pipeline, warp, generators, baking, runtime, gameplay, repo layout |
| [roadmap.md](roadmap.md) | Technology choices, milestones with exit criteria, per-technology tracks, risks, open questions |
| [data-sources.md](data-sources.md) | Allowed and forbidden sources, how semantic layers are fused, coverage tiers, licensing, depiction policy |
| [decisions.md](decisions.md) | Decision log: what we decided, why, and whether it's settled |

How to keep these useful:

- `architecture.md` describes what we're building toward. Keep it current rather than historical.
- Any change to a decision gets a new entry in `decisions.md`. Old entries are marked superseded, never rewritten.
- Format specs (e.g. `world-format.md`, planned for M0) live here next to the architecture doc.
