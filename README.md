# AI Lunch & Learn — Choose Your Own Adventure

Interactive presentation with live audience polling. No npm, no dependencies — just Node.js built-ins.

## Quick Start

```bash
node server.js
```

Then open:
- **Presenter:** http://localhost:3000  (run full-screen on projected laptop)
- **Audience:** http://[LOCAL_IP]:3000/vote  (displayed on screen for phones)

## Keyboard Shortcuts (Presenter View)

| Key | Action |
|-----|--------|
| `→` or `Space` | Next page |
| `←` | Previous page |
| `V` | Open audience vote |
| `C` | Close vote + reveal winner |
| `R` | Reset entire session |

## How Branching Works

1. **Intro** plays linearly (3 pages)
2. **Branch Point 1** — audience votes on what to cover first: Toolkit, Rules, Skills, or Build
3. Winning module plays in full, then **Branch Point 2** appears with remaining unvisited modules + "Head to Q&A"
4. This repeats until all chosen modules are done, then **Q&A** always closes

If only one module is left unvisited, the vote is skipped and it plays automatically.

## Sections

| ID | Label | Pages |
|----|-------|-------|
| `intro` | Introduction | 3 |
| `tools` | AI Toolkit | 2 |
| `rules` | Know the Rules | 1 |
| `skills` | Skills & Prompting | 2 |
| `build` | Build an Agent | 2 |
| `qa` | Q&A | 1 |

## Notes

- All state is in memory — restarting the server resets everything
- Audience votes are deduplicated by IP address
- SSE auto-reconnects with exponential backoff on disconnect
