# Free Fire Leaderboard — live OBS overlay

An animated leaderboard you control from a web page while it updates **live** inside OBS.
Ranks re-sort themselves the moment a score goes higher. Zero dependencies — just Node.js.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/olitillinfintye/free-fire-leaderboard)

---

## Run it locally

Double-click **`start.bat`**, or:

```bash
node server.js
```

The console prints your links:

```
Control panel : http://localhost:8080/
OBS overlay   : http://localhost:8080/overlay
Share on your network: http://192.168.x.x:8080/overlay
```

## Add it to OBS

1. **Sources → + → Browser**
2. URL: paste the overlay link (the **Copy** button in the control panel gives the right one)
3. Width **1920**, Height **1080**
4. Untick *Shutdown source when not visible*

The background is transparent, so it sits straight on top of your gameplay.

## Control it

Open the control panel in any browser — same PC, another PC, or your phone on the same
Wi-Fi. Every edit reaches the overlay instantly over SSE; you never refresh the browser source.

| Feature | What it does |
|---|---|
| **+ Add player** | New row, name focused and ready to type |
| **+100 / −100** | Instant score buttons for live matches |
| **Auto-rank by score** | Highest score is always rank 1 — rows slide into place on the overlay as you type |
| **★ / 💀** | Highlight a row in red, or grey it out as eliminated |
| **Click the rank number** | Flashes that row on stream |
| **🏆 BOOYAH!** | Full-screen winner burst |
| **↻ Replay intro** | Re-runs the staggered entrance animation |
| **Hide overlay** | Slides the whole board off-screen, then back |
| **Bulk paste** | Paste `Name, Score` lines or a spreadsheet column |
| **Auto-cycle** | Pages through 20+ players a few rows at a time |

Turn **Auto-rank** off if you want to drag rows into a manual order instead.

---

## Getting players onto the board

Three ways, all producing the same short name format: **first name + one letter of the
surname**. "Oliyad Tesfaye" becomes **Oliyad T**.

### 1. Let players add themselves (easiest)

Share the **`/join`** link — it's in the control panel under **Player sign-up**, with a
Copy button. Players open it on their phone, type their name, and land on the board
instantly. They see exactly how their name will appear *before* they commit, then get a
live view of the leaderboard.

- Toggle **Open** off to close entries once the match starts.
- New sign-ups pop up as a notification in your control panel and flash green in the list.
- Duplicate names are rejected, and sign-ups are rate limited so nobody can flood the board.
- **UPPERCASE** forces every name to caps, matching the classic Free Fire look.

Sharing the link: on your own network use the address the panel suggests (not
`localhost` — phones can't reach that). If the app is deployed, it's just your site's
address with `/join` on the end.

### 2. Import a Google Form

If you collected sign-ups with a Google Form, hit **Google Form** in the control panel.

- **Paste the link** to the responses spreadsheet (Sheets → Share → *Anyone with the link*),
  and the server fetches it for you, or
- **paste the rows** straight out of the sheet — CSV or tab-separated both work.

It picks the name column automatically (preferring an "IGN"/"in-game name" column over
"full name", and never a Timestamp or Email column) and shows you a before → after
preview of every name. You can override the column, pull scores from a second column,
force uppercase, and skip anyone already on the board.

### 3. Type them in

**+ Add player**, or **Bulk paste** for a plain list of names.

Name formatting rules, if you're curious:

| You type | Board shows | Why |
|---|---|---|
| `Oliyad Tesfaye` | `Oliyad T` | first name, initial of the last |
| `mary jane watson` | `Mary W` | middle names ignored |
| `Watson, Mary` | `Mary W` | "Last, First" is detected and flipped |
| `jean-luc picard` | `Jean-Luc P` | both halves capitalised |
| `McArthur Wallace` | `McArthur W` | existing capitals are never touched |
| `AXON` | `AXON` | a single name is left alone |

## Overlay URL options

Add these to the overlay URL when a scene should differ from the panel settings:

| Param | Example | Effect |
|---|---|---|
| `scale` | `?scale=1.3` | Bigger / smaller board |
| `rows` | `?rows=5` | Show only the top N |
| `align` | `?align=left` | Corner placement |
| `theme` | `?theme=neon` | classic · neon · crimson · ice |
| `title` / `sub` | `?title=FINALS` | Per-scene heading |
| `bg` | `?bg=1` | Solid preview background (browser testing only) |
| `nostatus` | `?nostatus=1` | Hide the "reconnecting" chip |

Example: `http://localhost:8080/overlay?scale=1.2&rows=5&align=left`

---

## Deploy to Render

The repo ships a `render.yaml` blueprint, so Render sets everything up for you.

1. Click **[Deploy to Render](https://render.com/deploy?repo=https://github.com/olitillinfintye/free-fire-leaderboard)** (sign in with GitHub if you haven't)
2. Render reads `render.yaml` and asks for one value: **`LB_KEY`**. Type any password you like — that's what protects your control panel.
3. **Apply** — it builds in under a minute. There's nothing to install, so the build is instant.

You get a URL like `https://free-fire-leaderboard.onrender.com`:

- **Overlay for OBS** → `https://…onrender.com/overlay` — open, no key, share it freely
- **Player sign-up** → `https://…onrender.com/join` — open, send this to your players
- **Control panel** → `https://…onrender.com/?key=YOUR_KEY` — only works with the key

Deployed is the nicest way to run the sign-up page: players join from mobile data without
needing to be on your Wi-Fi.

Notes for the free plan:

- The service sleeps after 15 minutes with no traffic and takes ~30 s to wake. Load the
  overlay a minute before you go live.
- Storage is ephemeral: `data.json` resets when the service restarts or redeploys. Use
  **Export** in the control panel to keep a copy of a board you care about.

### Other hosts

Any host that runs a persistent Node process works — Railway, Fly.io, a VPS. It reads
`PORT` and `LB_KEY` from the environment. Serverless platforms (Vercel, Netlify,
GitHub Pages) will **not** work: SSE needs a connection that stays open.

### Or go live from your own PC in one click

Double-click **`deploy.bat`** (or `node tools/deploy.js`). It starts the server with a
control key, opens a Cloudflare tunnel, and prints your three links:

```
OBS overlay    https://….trycloudflare.com/overlay
Player sign-up https://….trycloudflare.com/join
Your controls  https://….trycloudflare.com/?key=…
```

They're also saved to `public-url.txt`. The key is generated once and kept in `.lbkey`,
so your control-panel bookmark keeps working between runs. Ctrl+C stops everything.

Needs no account, but the **address changes every restart**, and it only runs while your
PC is on. For a fixed address, use Render above.

## Locking the controls

```bash
node server.js --key mysecret
```

or set `LB_KEY=mysecret` in the environment. The control panel then needs
`?key=mysecret`. The overlay and the player sign-up page stay open on purpose — OBS
never needs a key, and neither do your players.

## Files

```
server.js             zero-dependency HTTP + SSE server
render.yaml           Render blueprint
data.json             your board, saved automatically (gitignored)
public/control.html   control panel
public/overlay.html   the OBS overlay
public/join.html      player sign-up page
public/names.js       name formatting + CSV parsing (shared by server and pages)
tools/test-names.js   tests for the above — `node tools/test-names.js`
tools/deploy.js       starts the server + a public tunnel, prints the links
start.bat             one-click local launcher
deploy.bat            one-click public launcher
```

Other flags: `node server.js --port 9000`
