---
name: VibeLink
description: >
  Local-first Agent Remote Console - a multi-route bridge for continuing Codex
  and Claude Code agent work from web and mobile clients.
colors:
  primary: "#202124"
  ink: "#202124"
  inkSoft: "#5F6668"
  inkFaint: "#8B9497"
  canvas: "#FBFBFA"
  surface: "#FFFFFF"
  surfaceSoft: "#F4F5F3"
  sidebar: "#EAF8FA"
  sidebarWarm: "#F3F6E8"
  border: "#DCE3E1"
  borderStrong: "#C9D2D0"
  command: "#1F2322"
  accent: "#FF5A1F"
  focus: "#147F78"
  success: "#147F78"
  warning: "#A86F1B"
  danger: "#C23B2E"
typography:
  h1:
    fontFamily: Inter
    fontSize: 1.75rem
    fontWeight: 520
    lineHeight: 1.3
  h2:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: 560
    lineHeight: 1.35
  body:
    fontFamily: Inter
    fontSize: 0.9375rem
    lineHeight: 1.58
  mono:
    fontFamily: Cascadia Mono, JetBrains Mono, Fira Code, monospace
    fontSize: 0.85rem
    lineHeight: 1.5
rounded:
  sm: 6px
  md: 10px
  lg: 14px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.command}"
    textColor: "#FFFFFF"
    rounded: "{rounded.pill}"
    padding: 10px 18px
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "#3A3D3C"
    textColor: "#FFFFFF"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 8px 12px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  tag-agent:
    backgroundColor: "{colors.surfaceSoft}"
    textColor: "{colors.inkSoft}"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  tag-route-a:
    backgroundColor: "#EAF8FA"
    textColor: "#0F665F"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  tag-route-b:
    backgroundColor: "#E8EEF7"
    textColor: "#365F9D"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  tag-route-c:
    backgroundColor: "#FFF1DE"
    textColor: "#7A4C0D"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 8px 12px
---

## Overview

VibeLink is a **local-first Agent Remote Console** - a multi-route bridge for continuing Codex and Claude Code agent work from web and mobile clients. The interface should feel like Codex Desktop: quiet, pale, precise, and tool-focused. The first impression is a mist-blue navigation rail beside a nearly white workspace, with restrained black controls and small orange permission/status emphasis.

Three routes share one Web frontend (React + Vite), one backend bridge:
- **Route A (Codex Desktop Remote)** - remote control of an existing Codex Desktop session.
- **Route B (VibeLink CLI Runtime)** - self-hosted, controllable agent execution layer with permissions, tool lifecycle, and sandbox.
- **Route C (Live Call Assistant)** - real-time call transcription + question detection + agent response.

## Colors

The palette intentionally avoids saturated product gradients. It copies the visual temperature of Codex: a pale cyan sidebar, white central canvas, warm gray separators, graphite text, and one orange permission accent.

- **Ink (#202124):** Primary text, titles, icons, and compact command controls.
- **Ink soft (#5F6668):** Secondary labels, metadata, disabled-ish navigation text.
- **Ink faint (#8B9497):** Timestamps, placeholder text, quiet helper copy.
- **Canvas (#FBFBFA):** Main workspace background. It should read as white, not gray.
- **Surface (#FFFFFF):** Composer, cards, modals, list hover states.
- **Surface soft (#F4F5F3):** Toolbars, grouped controls, code/card headers.
- **Sidebar (#EAF8FA):** Left navigation background, matching Codex's airy blue-green rail.
- **Sidebar warm (#F3F6E8):** Very subtle top/edge wash when a panel needs warmth.
- **Border (#DCE3E1):** Default dividers and input borders.
- **Border strong (#C9D2D0):** Active list outlines and stronger separators.
- **Command (#1F2322):** Primary send/run buttons and high-emphasis icon buttons.
- **Accent (#FF5A1F):** Permission labels, destructive warnings that need attention, "full access" style emphasis.
- **Focus / Success (#147F78):** Focus rings, ready/online states, subtle route-A identity.
- **Warning (#A86F1B):** Pending/running states and route-C call states.
- **Danger (#C23B2E):** Errors, disconnects, destructive actions.

## Typography

- **Headings (Inter Medium):** Codex-style headings should be calm and readable rather than heavy. Use 520-560 weight for page titles and section headers.
- **Body (Inter Regular):** Keep the UI compact at 15px with generous line height for message text and logs.
- **Monospace (Cascadia Mono / JetBrains Mono):** Use for terminal output, JSON, paths, and command transcripts.

## Layout & Spacing

- Use 16px as the base spacing unit, with tighter 8px rhythm inside toolbars and list rows.
- Keep the desktop shell as a left sidebar plus a large white work area.
- Sidebar backgrounds use `sidebar`; central panes use `canvas`; cards and composer shells use `surface`.
- Cards and inputs keep moderate 10-14px radius. Icon/send buttons may use pill radius.
- Avoid colored left-border route accents as the default pattern; prefer small badges and text/icon color shifts.

## Components

- **Buttons:** Primary action buttons are graphite/black with white icons or text. Secondary controls are transparent or `surfaceSoft`.
- **Composer:** Use a white surface, soft shadow, rounded shell, and black circular send button.
- **Tags/Chips:** Route badges are soft tints, not saturated blocks. Text carries the state color.
- **Cards:** White cards with a thin warm-gray border and very soft shadow.
- **Inputs:** White background, subtle border, teal focus ring, no saturated fills.
- **Status indicators:** Small dots in success/warning/danger colors; avoid large colored panels.

## Do's and Don'ts

- **Do** keep the interface mostly white, pale cyan, graphite, and warm gray.
- **Do** reserve orange for permission, warning, and attention states.
- **Do** use black circular icon buttons for high-confidence primary actions like send.
- **Do** keep route colors quiet and badge-sized.
- **Don't** return to the old indigo/purple/cyan gradient feel.
- **Don't** make the sidebar dark.
- **Don't** fill cards with route colors; route identity should be a small annotation.
