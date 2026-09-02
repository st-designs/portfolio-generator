# Portfolio Generator — Scope & Roadmap

## Abstract

A local web tool that turns any live website into a polished, ready-to-use portfolio kit. Give it a URL and it crawls the site, extracts the logo and brand color, captures fully-rendered screenshots across desktop / tablet / mobile frames, and composes them into professional SVG assets — logo tiles, hero/featured shots, device mockups, multi-screen showcases, and a scrolling MP4 video. Every asset is seeded (reproducible variety), regenerable individually or per section from a fresh crawl, and exportable as SVG/PNG/JPEG at 1–4× — sized for Figma, portfolios, and social media.

**Primary user & workflow:** a designer/agency producing case-study visuals. Everything downstream lands in Figma, so outputs must be *correct and polished*, not infinitely editable here.

---

## Guiding principle for scope decisions

> The tool's job is **flawless capture + beautiful variety with near-zero input**.
> Deep manual editing is Figma's job. Anything that recreates Figma inside this tool is out.

### In / Out / Parked

| ✅ In scope | 🅿️ Parked (maybe later) | ❌ Out of scope |
|---|---|---|
| Capture reliability ("patience" presets, double-shot verification) | Chrome extension (Phase 4) | Pan/zoom/reposition editor on images |
| Keep-or-hide toggle for popups/banners/overlays | Public hosted version (Phase 3) | Multi-user accounts, cloud storage |
| New "Screenshots" section (plain single-frame captures) | Per-image style presets/themes | Template marketplace |
| Master style controls + per-section overrides | Editable text/annotations on outputs | Full drag-drop layout editor |
| Corner-radius control (master + per-section) | PDF/case-study export | Editing the website content itself |
| More seed variety from reference designs | | |
| Quick-edit in preview: background + radius only | | |

**Why quick-edit stops at background + radius:** those are two attribute swaps in the SVG — instant, safe, zero UI complexity. Pan/zoom means transform math, clipping, state persistence, and undo — that's a layout editor. Regenerate + Figma covers it better.

---

## Information architecture (proposed)

Three-layer mental model, industry-standard "global → section → item":

```
SIDEBAR
├── 1. GENERATE                      (always visible, zero-config path)
│   ├── Website URL(s)               one per line = mix sites
│   └── [ Generate ]
│
├── 2. OUTPUTS                       (what to create — one panel per section)
│   │   Each panel: toggle + what's unique to it + a collapsed "Style override"
│   │   row (background + corner radius; overrides the master when set).
│   ├── Logo            assets (wordmark/icon/both) · override: background only
│   ├── Display         homepage only · override: bg + radius
│   ├── Mockups         count · devices · pages · override: bg + radius
│   ├── Showcase        count · devices · pages · override: bg + radius
│   ├── Screenshots     NEW — URL list (one image per URL) · mode: viewport
│   │                   and/or full-length · own dimensions · plain or boxed
│   │                   · override: bg + radius
│   └── Video           page URL · own dimensions · bg
│
├── 3. STYLE                         (master defaults — any section can override)
│   ├── Backgrounds     master override (off by default → per-section defaults:
│   │                   logo/mockups/display = brand auto, showcase/shots = grey)
│   ├── Corner radius   default 24px · "seeded" option for variety
│   ├── Overlays        ☑ Hide popups, cookie/newsletter banners, chat, floaters
│   │                   (untick = capture the site exactly as-is)
│   ├── Capture patience  Fast / Normal / Thorough
│   └── Render frames   desktop · tablet · mobile (px) — master-only for
│                       Display/Mockups/Showcase (they share ONE capture pass;
│                       per-section frames would mean re-crawling the site per
│                       section). Screenshots & Video capture independently,
│                       so they own their dimensions.
│
└── 4. ADVANCED                      (rarely touched)
    ├── Crawl pages override
    └── Layout seed
```

**Override rule (one rule, everywhere):** `per-section setting → master setting → auto/seed`.
Per-section style overrides live *inside* each Outputs panel behind a collapsed "Override style" row, so panels stay clean and the master stays the single source of truth.

**Results area (unchanged structure):** sticky bar → site header → category groups → cards.
Card actions: Preview (lightbox with **quick-edit: background, radius** + save), Regenerate, Save, select-checkbox. Category rows: Regenerate all, Select all, Download selected.

---

## Phase checklist

### ✅ Phase 1 — Ideation & consolidation (this document)
- [x] Scope abstract, in/out/parked fences
- [x] Information architecture proposal
- [x] Scope reviewed and carried into implementation

### 🔨 Phase 2 — Implementation (next; work in this order)
**2a. Capture reliability v3** *(foundation — everything depends on it)*
- [x] "Patience" presets (Fast/Normal/Thorough) controlling all wait budgets & timeouts
- [x] Double-shot verification: capture → wait → capture again → pixel-diff; only accept when stable
- [x] Wait for CSS background-images & srcset assets (current checks only cover `<img>`)
- [x] Per-page retry budget with reload, and honest QC WARN lines listing which page/section is suspect

**2b. Overlay control**
- [x] Master "Hide overlays" toggle (on by default) wiring ALL existing removal layers
- [x] Untick = capture the site exactly as-is (nothing dismissed or hidden)

**2c. New Screenshots section**
- [x] URL list — one output image per URL
- [x] Mode per run: Viewport (first screen, no scrolling) and/or Full-length — one or both
- [x] Own dimensions (independent of master render frames)
- [x] Plain (full-bleed) or Boxed (bg solid/gradient + screenshot radius)
- [x] Unset options = seeded randomness, like every other section

**2d. Style system**
- [x] Master background control (disabled by default; per-section wins)
- [x] Corner radius: master (default 24) + per-section override + seeded option — applied to featured card, showcase strips, boxed screenshots (device bezels keep hardware radii)
- [x] Sidebar IA restructure per section 2 above

**NEW: Animated showcase** *(added on request)*
- [x] "Animated showcase" toggle in the Showcase panel — one MP4 per run
- [x] Three motion styles, seeded: slide from alternating sides / rise+fade / zoom settle; ends on the exact static composition
- [x] GIF export option in the export dialog (960px, 12fps)

**2e. Variety expansion**
- [ ] Implement new mockup/showcase styles from your reference screenshots (waiting on the screenshots)

**2f. Preview quick-edit**
- [ ] Lightbox controls: background color + frame radius, live SVG rewrite, Save/Save-as-copy *(deferred — next round)*

### ✅ Phase 3a — Desktop and local web app

- [x] Native macOS Electron shell with integrated traffic lights
- [x] Windows packaging configuration (installer + portable)
- [x] Local website from the same server and UI
- [x] Native desktop save dialog with an explicit destination
- [x] Serialized capture queue to prevent parallel Chromium contention
- [x] Offline export dependency (no CDN required)

### 🌐 Phase 3b — Public hosting
> ⚠️ Reality check: this is a Node + Playwright **server** that launches a full Chromium per job. Shared hosting (PHP/static, like your $30/yr plan) cannot run it — no Node processes, no browser binaries, not enough RAM. Options, cheapest first:
>
> 1. **Local app + landing page (free)** — keep generation on your Mac; shared hosting serves a landing/download page under your domain. Zero rearchitecture. *Recommended starting point.*
> 2. **Cloudflare Browser Rendering free tier (free, limited)** — ~10 browser-minutes/day, 3 concurrent. One generation ≈ 2–5 browser-min → roughly 2–4 free runs/day. Requires rewriting the capture layer against Cloudflare's API (Workers). Real work, viable later.
> 3. **Container hosts** — Railway has a ready Playwright template; Leapcell advertises free project hosting; classic VPS ≈ $5/mo. Only worth it if the tool gets real outside users.
>
> Before ANY public exposure regardless of host:
- [ ] Job queue + concurrency limits (one Chromium per job eats RAM)
- [ ] Rate limiting / simple access key (it fetches arbitrary URLs on request — abuse target)
- [ ] Output storage & cleanup policy
- [ ] Domain / subdomain pointing at wherever it runs

### 🧩 Phase 4 — Chrome extension
- [ ] Capture the current tab directly (logged-in pages become possible!)
- [ ] Reuses the compose engine via the Phase 3 backend
- [ ] Scope it *after* Phase 3 exists — the extension is a thin capture client, not a rewrite

---

## Decisions locked (from review)
1. **Per-section style**: background + corner radius overridable in every section (logo: bg only); master is the fallback; unset = seeded.
2. **Radius default**: master 24px; per-section override; "seeded" opt-in.
3. **Screenshots**: viewport and/or full-length per URL (no scroll-position-X — hit and miss); own dimensions.
4. **Render frames**: master-only for Display/Mockups/Showcase (single capture pass); Screenshots & Video own theirs.
5. **Hosting**: Phase 3 starts as local app + landing page on shared hosting; Cloudflare Browser Rendering free tier is the first candidate for a true hosted version.

## Remaining product work

- Reference screenshots for new mockup/showcase styles (2e)
- Preview quick-edit controls for background and corner radius (2f)
- Public hosting safeguards and deployment (3b)
- Chrome extension capture flow (Phase 4)
