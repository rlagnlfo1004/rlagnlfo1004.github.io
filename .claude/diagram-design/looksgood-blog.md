<!-- diagram-design-profile
name: it.looksgood2.me tech blog
slug: looksgood-blog
source-url: https://it.looksgood2.me
created: 2026-08-31
updated: 2026-08-31
notes: Astro blog. Diagrams ship as inline SVG in markdown and read colors from global.css tokens, so every value below has a CSS var name. Emit var(--token, #fallback), never a bare hex.
-->
# Style Guide

**The single source of truth for colors, typography, and tokens.** Every diagram draws from this — not from hex values inlined in other reference files.

This skin is not a standalone palette. It is a **mirror of `src/styles/global.css`** in the `blog-site` repo (`rlagnlfo1004.github.io` / it.looksgood2.me). The blog renders diagrams as **inline SVG inside markdown**, so the SVG inherits the page's CSS custom properties and flips with the light/dark toggle for free.

**The hard rule of this skin: every paint attribute is `var(--token, #fallback)`.** The hex values in the tables below are only the fallback half. A baked hex turns into a bright slab in dark mode, which is exactly what the blog's inline-SVG convention exists to prevent.

```svg
<rect fill="var(--surface, #FAFAFB)" stroke="var(--rule, rgba(22,24,26,.09))" stroke-width="1"/>
<text fill="var(--ink, #16181A)">주문 서비스</text>
```

---

## Tokens

### Semantic roles

Every token is referred to by **semantic role**, not by its hex value. Type references (`type-*.md`) and SKILL.md say `accent`, not `#3182F6`.

| Role | CSS var | Purpose | Default (light) | Default (dark) |
|---|---|---|---|---|
| `paper` | `--bg` | Page background. **Do not paint it** — the diagram sits transparent on the post | `#FFFFFF` | `#0E1013` |
| `paper-2` | `--surface` | Default node fill, container bg | `#FAFAFB` | `#16181A` |
| `ink` | `--ink` | Primary text, primary stroke | `#16181A` | `#F4F5F7` |
| `muted` | `--ink-2` | Secondary text, figure titles, default arrow stroke | `#545A64` | `#A8ADB5` |
| `soft` | `--ink-3` | Sublabels, arrow labels, boundary labels, **and every axis line / arrow stroke** (@ 1.2 with a `marker-end`) | `#8B9099` | `#6C727C` |
| `rule` | `--rule` | Hairline borders | `rgba(22,24,26,0.09)` | `rgba(244,245,247,0.12)` |
| `rule-solid` | `--rule-soft` | The one hairline @ 0.5 that separates a footnote strip from the figure body. **Weaker than `rule`, not stronger** — this blog has no heavier border than `rule`; anything that must be seen is `soft` | `rgba(22,24,26,0.06)` | `rgba(244,245,247,0.07)` |
| `accent` | `--clay` | Focal stroke / chip fill. 1–2 per diagram | `#3182F6` | `#4593FC` |
| `accent-tint` | `--clay-soft` | Fill for accent-bordered boxes | `#EAF2FE` | `#16243B` |
| `link` | `--clay-text` | **Accent text only.** `accent` on paper is 3.71:1 — under AA | `#1B64DA` | `#6BA6FD` |

Two extra roles this blog needs and the shipped schema does not name:

| Role | CSS var | Purpose | Default (light) | Default (dark) |
|---|---|---|---|---|
| `sunk` | `--sunk` | Nested / inner box fill one level below `paper-2` | `#F1F3F6` | `#1D2024` |
| `chip-on-accent` | — | Text on a solid `accent` fill. The one literal hex allowed | `#FFFFFF` | `#FFFFFF` |

> **Accent has two values on purpose.** `--clay` is the *fill and stroke*; `--clay-text` is the *text*. Never set a label to `var(--clay)` — it fails contrast on white. Never set a stroke to `var(--clay-text)` — it reads muddy against `--clay-soft`.

### Inversion rule (light → dark)

There is nothing to invert by hand. `global.css` redefines every token under `:root[data-theme="dark"]`, so an SVG built out of `var()` flips itself. The dark column exists only so a fallback can be sanity-checked, and so a diagram exported to PNG can be re-rendered in the other theme.

### Series palette (multi-series chart types only)

The blog's token set is deliberately monochrome + one blue ("no rainbow"), so it names no series colors. Prefer, in order:

1. `accent` for the focal series and `ink`/`muted`/`soft` for the rest — enough for 3 series.
2. A **mermaid** figure (`<figure class="mermaid-figure">`), where `src/scripts/mermaid.ts` already resolves a fifth `warn` rose from script.
3. Only if a genuine 4+ series chart demands it: add the pair to `global.css` in the *same* change and reference it as `var(--series-1, #5E7A9B)`. Never inline a bare hex.

| Token | CSS var | Light | Dark | Notes |
|---|---|---|---|---|
| `series-1` | `--series-1` | `#5E7A9B` (dusty-blue) | `#82A0C0` | Nearest neighbour to the blog blue |
| `series-2` | `--series-2` | `#6F8F7C` (sage) | `#8FAF9C` | |
| `series-3` | `--series-3` | `#B8915A` (mustard) | `#D3AD7A` | |
| `series-4` | `--series-4` | `#D93D42` (rose) | `#F1787B` | Matches `mermaid.ts` `warn` — reuse it for failure/lock/deadlock |
| `series-5` | `--series-5` | `#6E6479` (slate) | `#8D8298` | |

Fills sit at `0.18` opacity light, `0.22` dark; strokes use the full color.

### Terminal skin (opt-in alternate)

Unchanged from the shipped skin — it is a fixed, self-contained CLI-chrome palette, not part of this blog's tokens. Because it hard-codes its own darks, **a terminal-primitive figure does not flip with the theme toggle.** Use it only in a standalone HTML/PNG export (a social card), never as an inline `.diagram` in a post.

| Token | Hex | Purpose |
|---|---|---|
| `terminal-page` | `#0a0a0a` | Page background behind the window |
| `terminal-paper` | `#141414` | Window body, node fill |
| `terminal-bar` | `#1b1b1b` | Titlebar strip |
| `terminal-border` | `#2b2b2b` | Window border, hairlines |
| `terminal-ink` | `#f5f5f5` | Primary text, primary stroke |
| `terminal-muted` | `#9a9a9a` | Secondary text, sublabels, ring stroke |
| `terminal-soft` | `#5c5c5c` | Tertiary — inactive dots, spokes |
| `terminal-accent` | `#4593FC` | The one accent — matches the blog's dark-mode `--clay` |
| `terminal-accent-tint` | `rgba(69,147,252,0.12)` | Fill for accent-bordered boxes |

---

## Typography

**This blog has two families, not three.** `global.css`: *"화면 어디서도 서체 경계가 보이지 않게 글자는 전부 Pretendard 로 읽고, 보폭이 맞아야 하는 것(코드, 숫자, 라벨)만 mono 로 간다."* There is no serif, and Instrument Serif / Geist / Geist Mono are not loaded. **Never emit a Google Fonts `<link>` and never emit an `Instrument Serif` or `Geist` family** — the shipped font stack section does not apply here.

`.prose .diagram text { font-family: var(--font-sans); }` already forces the sans face on every `<text>`, so **omit `font-family` entirely** unless the slot is mono, and then write exactly `font-family="var(--font-mono)"`.

| Role | Family | Size | Weight | Usage |
|---|---|---|---|---|
| `title` | inherit (`--font-sans`) | 13px | 600, `fill=muted` | The one-line figure title at `x=0 y=14`. Not a page H1 — the post's `##` is the heading |
| `node-name` | inherit (`--font-sans`) | 11.5–12px | 700 | Human-readable labels |
| `sublabel` | `var(--font-mono)` if Latin/technical, else inherit | 10.5–11px | 400 | Port, protocol, URL, field type, measured number |
| `eyebrow` | inherit (`--font-sans`) | 11px | 700, `fill=soft` | Zone / lane labels. **No uppercase, no tracking** |
| `arrow-label` | inherit (`--font-sans`) | 10.5px | 400, `fill=soft` | Arrow annotations |
| `callout` | inherit (`--font-sans`) | 11px | 400, `fill=soft` | Footnote lines below the baseline rule, or a `<p class="diagram-note">` under the figure |

### Type ramp

The whole ramp is **one step smaller than the shipped standard ramp**, because a 720-unit viewBox renders at ~820 CSS px inside a `--read: 51.25rem` column — near 1:1, not scaled down. Measured across the blog's 67 existing diagrams: `11` (298×), `10.5` (235×), `11.5` (167×), `10` (134×), `12` (83×), `13` (75×).

| Slot | Size |
|---|---|
| Figure title | 13 |
| Node name | 11.5–12 |
| Sublabel / arrow label / footnote | 10.5–11 |
| Smallest permitted | 9.5 |

**Hangul floor is 10.5px here, not 12px** — Pretendard holds up where Geist has no Hangul at all. Do not go below 9.5 for any script.

### Korean labels

Korean is the blog's primary language, so this is the default case, not an exception.

- **No font stack juggling.** Pretendard carries Hangul. Emit no `font-family` and it resolves.
- **Never put Hangul in a mono slot.** `--font-mono` is JetBrains Mono / D2Coding — keep Korean out of it. Ports, protocols, field types, and measured numbers stay Latin and stay mono.
- **Eyebrows and arrow labels do not switch register**, because this skin never uppercases or tracks them in the first place. A Korean arrow label is just an 10.5px sans label.
- **Width budget:** every Unicode wide or full-width character costs 1em; every other character costs its face's Latin advance (0.58em Pretendard sans, 0.60em mono); nonspacing marks cost nothing. Sum, multiply by font size, add padding, round the box up to the next multiple of 4. Count **per character, not per script** — `주문 v2.1` is two full-width syllables and five narrow characters.
- `word-break: keep-all` governs the prose, not `<text>`; SVG text does not wrap. Break a long Korean label into two `<text>` lines 16px apart by hand.

**Load-bearing rule:** mono is for *technical* content only. Names go in the inherited sans. There is no serif register in this skin — an editorial aside becomes a `<p class="diagram-note">` in the markdown, below the figure.

---

## Stroke, radius, spacing

| Token | Value | Use |
|---|---|---|
| `stroke-thin` | `0.5` | Hairline card borders — matches the blog's `0.5px solid var(--rule)` chrome |
| `stroke-default` | `1` | Most strokes, node outlines |
| `stroke-strong` | `1.2` | Accent-bordered focal boxes, axis arrows |
| `radius-sm` | `5` | Small tags, inner boxes |
| `radius-md` | `6` | Node boxes |
| `radius-lg` | `8` | Containers, matches `--radius: 8px` |
| `grid` | `2` | Coords land on even numbers; the type ramp uses `.5` steps so a strict 4-grid does not hold |

---

## Node type → treatment

| Type | Fill | Stroke |
|---|---|---|
| `focal` (1–2 max) | `accent-tint` → `var(--clay-soft, #EAF2FE)` | `accent` → `var(--clay, #3182F6)` @ 1.2 |
| `backend` | `paper-2` → `var(--surface, #FAFAFB)` | `rule` → `var(--rule, rgba(22,24,26,.09))` @ 1 |
| `store` | `sunk` → `var(--sunk, #F1F3F6)` | `rule` @ 1 |
| `external` | `paper-2` | `soft` → `var(--ink-3, #8B9099)` @ 1 |
| `input` | `sunk` | `soft` @ 1 |
| `optional` | none | `soft` @ 1 dashed `4,4` |
| `security` | `paper-2` | `accent` @ 1 dashed `4,4` |
| `chip` (solid accent pill) | `accent` → `var(--clay, #3182F6)` | none; label `#FFFFFF` @ 700 |

---

## Customizing the skin

This profile tracks `src/styles/global.css`. **When those tokens change, update this profile — not the other way round.** `global.css` is the source; this file is the mirror.

```
claude → /diagram-design:profile update looksgood-blog
```

### Constraints (don't break these)

- **Every paint attribute is `var(--token, #fallback)`.** One bare hex and the figure breaks in dark mode. The only exceptions: `#FFFFFF` label text on a solid `accent` chip.
- **Fallbacks must match the current `global.css` values.** Some older posts still carry the pre-redesign warm fallbacks (`#BF5F3B`, `#221F1B`); those are stale. Do not copy fallbacks from a post — read them from `global.css`.
- **`paper` is pure white and that is deliberate.** The shipped "paper is warm-neutral, not pure white" constraint is overridden here: the blog is `#FFFFFF` / `#0E1013`. Don't paint a background rect at all.
- **One accent, and it has two values** (`--clay` fill/stroke, `--clay-text` text). Not two accents.
- **Two families, not three.** No serif. No Google Fonts link. No `Geist`, no `Instrument Serif`. Never `JetBrains Mono` *by name* — write `var(--font-mono)`.
- **Container is clean by default.** No border, no background, no framed variant. `.prose .diagram` gives `margin: 32px 0` and full width; the figure sits directly on the post.
- **No dot pattern.** The blog has no dotted-paper register.
- **No shadows in the figure.** `--cast` exists for floating UI chrome (buttons, lightbox), not for diagram nodes.
