# Segan Sessions Design System

A capture tool, one screen, **light + dark + system themes**. Tokens are lifted from the Studio Segan
website design system, so the app and the brand stay one family.

## 1. Atmosphere & Identity

A quiet control room where the footage is the only bright thing. The signature is the **live
output frame**: everything outside the crop is dimmed; what glows in the middle IS the reel.
Overlays that sit on footage (teleprompter, warnings) are dark glass in BOTH themes — video is
always a dark surface. Chrome-less, website-flavored: tonal surfaces, Space Grotesk headings,
one blue accent, one red record button.

## 2. Color

Brand accents (theme-independent): `--blue #246CF8` (+ `--blue-400 #5E92FF` hover), `--indigo
#3F38E0`, `--cyan #38D6F0`, `--gold #EFB519` (**logo i-dot + warnings only, never text**),
`--rec/--err #E5484D`, `--ok #30A46C`, `--grad-brand` (blue→indigo→purple, logo mark only).

| Role | Token | Dark | Light |
|---|---|---|---|
| Page | `--surface-0` | `#07070B` | `#F4F6F9` |
| Panels | `--surface-1` | `#101119` | `#FFFFFF` |
| Inputs/cards | `--surface-2` | `#15161F` | `#ECEFF4` |
| Hover/raised | `--surface-3` | `#1C1E2A` | `#E2E6EE` |
| Text | `--text-1/2/3` | `#EEF0F5 / #A6ABB9 / #6B7080` | `#16181D / #565B66 / #8A8F9B` |
| Borders | `--border-1/0` | `rgba(255,255,255,.15/.08)` | `rgba(16,18,22,.14/.08)` |

On-footage glass (both themes): `--glass rgba(7,7,11,.74)` + `--glass-line rgba(255,255,255,.14)`
+ `--glass-text #EEF0F5` + backdrop blur 16px.

Theme resolution: `html[data-theme]` set pre-paint from `localStorage ss-theme`
(system|light|dark); toggled by the header segmented control; `prefers-color-scheme` drives
"system". Accent = interactive only. No raw hex outside `style.css` `:root`/theme blocks.

## 3. Typography

Website stack via Google Fonts (graceful system fallback offline):
**Space Grotesk** (display: h2 panel titles, brand "SESSIONS", countdown, phone-stage title) ·
**Montserrat** (UI body 13px, buttons 12.5/600, labels 10.5/600 caps 0.09em) ·
**Noto Sans Bengali** (prompter, 20–54px slider, weight 600) · mono `SF Mono` (timer, filenames).

## 4. Spacing & Layout

Base 4px (`--s1..--s8`), radius `--r1 8px` (inputs/buttons) `--r2 14px` (panels/cards).
Header 52px · stage flexible + 304px rail · takes drawer · footer. `.layout{flex:1 0 auto}` —
never shrink below content. Single breakpoint 900px stacks the rail.

## 5. Components

Existing: tabs, buttons (primary/quiet/danger), record button, selects, take card, status pills,
overlay guides, countdown, toast — unchanged states per §6.

- **Brand lockup** — gradient S-arrows mark (from website `Mark.astro`) + inline wordmark SVG:
  `.ss-studio` fill blue, `.ss-dot` fill gold, `.ss-segan` fill currentColor (adapts per theme) +
  divider + "SESSIONS" in Space Grotesk caps.
- **Theme toggle** — 3-icon segmented pill (monitor/sun/moon SVGs, stroke 1.8); active =
  `--surface-0` bg + accent icon.
- **Teleprompter card** — dark glass card, default top-center (`top 14px`, translateX(-50%)),
  z-index 5. Header = grip + script title + play/restart + S/M/F width + recenter (`.pbtn` 24px
  ghost buttons). Body: centered prompter text, max-height 34vh, gradient mask fades top/bottom,
  `padding-bottom 40vh` so the tail scrolls to the reading point. Drag by header (fractions of
  stage box, persisted `ss-prompter-v1`); recenter restores default.
- **Composite stage interactions** — canvas is the input surface, but pointer/wheel act ONLY
  inside the output frame (letterbox areas are inert): drag = pan the screen region (always exact
  output ratio), scroll = smooth eased zoom toward cursor (1–12×, slider-synced, high-quality scaling), drag bubble = free move with
  snap to center lines (dashed blue guides, hidden while recording) and 36px margins; scroll over
  bubble = scale; drag its corner handle (22px white square, hidden while recording/locked) =
  stretch to any rectangle. Persisted `ss-composite-v2`.
- **Lock** — padlock button beside Reset; freezes ratio select + zoom/fit/reset + all bubble
  controls + canvas interactions. Active = accent-filled.
- **Privacy blur** — "Add blur area" mode (gold dashed outlines, crosshair cursor, Esc exits):
  drag boxes over sensitive content; stored in screen-video coordinates so they track pan/zoom;
  click a box in blur mode to remove. Outlines shown only in blur mode, never recorded.
- **Bubble controls** — shape (circle / rounded square / off), size slider, radius slider 0–50%
  (square corners), border width 0–14 + `input[type=color]`, position preset menu (6 anchors).
- **Viewport-fixed layout** — body is 100vh/overflow-hidden (>900px): the canvas always fits the
  screen (MacBook Air included); the rail scrolls internally; Takes is a collapsible bottom drawer
  (opens automatically after each save, list scrolls at max 34vh).
- **Tips toggle** — "?" icon button in header hides/shows all `.hint` text (`body.hide-hints`,
  persisted `ss-hints`).
- **Prompter resize** — corner handle scales the card (width 280px–stage, view height 90px–85%);
  width presets/recenter clear the custom size.

## 6. Motion & Interaction

Micro 120ms ease-out; standard 200ms `--ease cubic-bezier(0.22,1,0.36,1)` (website ease);
record pulse 1.2s. Transform/opacity only. All interactive elements: hover/active/focus-visible.
`prefers-reduced-motion` kills pulse + countdown scale.

## 7. Depth & Surface

Tonal-shift + 1px borders. Two sanctioned shadows: toast/menus `0 24px 60px -28px rgba(0,0,0,.7)`
(website `--shadow-card` tail) and the prompter card (same). Glass (blur) is reserved for
overlays that sit on footage.
