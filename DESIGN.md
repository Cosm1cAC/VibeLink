---
name: VibeLink
description: >
  Local-first Agent Remote Console — a multi-route bridge for continuing Codex 
  and Claude Code agent work from web and mobile clients.
colors:
  primary: "#1E1B4B"
  secondary: "#6366F1"
  tertiary: "#22D3EE"
  accent: "#F59E0B"
  neutral: "#F8FAFC"
  danger: "#EF4444"
  success: "#10B981"
typography:
  h1:
    fontFamily: Inter
    fontSize: 1.75rem
    fontWeight: 700
    lineHeight: 1.3
  h2:
    fontFamily: Inter
    fontSize: 1.35rem
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: Inter
    fontSize: 0.9375rem
    lineHeight: 1.6
  mono:
    fontFamily: JetBrains Mono, Fira Code, monospace
    fontSize: 0.85rem
    lineHeight: 1.5
rounded:
  sm: 6px
  md: 10px
  lg: 14px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "#4338CA"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: 10px 20px
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "#3730A3"
    textColor: "#FFFFFF"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.secondary}"
    rounded: "{rounded.md}"
    padding: 10px 20px
  card:
    backgroundColor: "#FFFFFF"
    textColor: "{colors.primary}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  tag-agent:
    backgroundColor: "#4338CA"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 2px 8px
  tag-route-a:
    backgroundColor: "#4338CA"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 2px 8px
  tag-route-b:
    backgroundColor: "#0E7490"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 2px 8px
  tag-route-c:
    backgroundColor: "#B45309"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 2px 8px
  input:
    backgroundColor: "#FFFFFF"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    padding: 8px 12px
---

## Overview

VibeLink is a **local-first Agent Remote Console** — a multi-route bridge for continuing Codex and Claude Code agent work from web and mobile clients. The UI evokes a premium developer tool with a deep indigo foundation, clean typography, and clear visual distinction between the three agent routes.

Three routes share one Web frontend (React + Vite), one backend bridge:
- **Route A (Codex Desktop Remote)** — remote control of an existing Codex Desktop session.
- **Route B (VibeLink CLI Runtime)** — self-hosted, controllable agent execution layer with permissions, tool lifecycle, and sandbox.
- **Route C (Live Call Assistant)** — real-time call transcription + question detection + agent response.

## Colors

The palette is rooted in a deep indigo with vibrant accent colors that differentiate the three routes.

- **Primary (#1E1B4D):** Deep indigo ink for headings, key text, nav bars.
- **Secondary (#6366F1):** Indigo-500 for interactive controls, links, route-A identity.
- **Tertiary (#22D3EE):** Cyan-400 for route-B highlights, live indicators, secondary actions.
- **Accent (#F59E0B):** Amber for route-C call states, warnings, attention signals.
- **Neutral (#F8FAFC):** Slate-50 background foundation — cool, technical.
- **Danger (#EF4444):** Red-500 for errors, disconnection, destructive actions.
- **Success (#10B981):** Emerald-500 for online status, successful operations.

## Typography

- **Headings (Inter Bold):** H1 for page titles, H2 for section headers within cards. Tight leading for density.
- **Body (Inter Regular):** Clean, readable at 15px for terminal logs, descriptions, and cards.
- **Monospace (JetBrains Mono):** All code blocks, tool output, JSON display, terminal emulation. Slightly smaller at ~13.6px to fit more content.

## Layout & Spacing

- Use 16px (md) as the base spacing unit; stack vertically with 24px (lg) between major sections.
- Cards get 14px radius for a modern, approachable feel; inputs and buttons use 10px.
- The main layout is a sidebar nav + main content area on desktop, bottom nav on mobile.
- Route-specific panels use the route's accent color as a left-border accent (4px) on cards.

## Components

- **Buttons:** Primary buttons use the route-specific accent color (secondary/cyan/amber). Ghost buttons for secondary actions.
- **Tags/Chips:** Each route has a tinted tag (`tag-route-a/b/c`) — use for route badges on session cards.
- **Cards:** White cards with large radius, subtle shadow, and optional left accent border matching the route color.
- **Inputs:** White background, subtle border, focus ring in the route's accent color.
- **Status indicators:** A small dot (8px) in success/danger colors for connection state.

## Do's and Don'ts

- **Do** use monospace for all terminal output and JSON display.
- **Do** use left-border accents on cards to visually group content by route.
- **Do** keep the sidebar dark (primary) and content area light (neutral).
- **Don't** use tertiary (cyan) for destructive actions — use danger (red).
- **Don't** mix route accent colors in the same card; a card belongs to one route.
- **Don't** use font weights below 400 for body text on dark backgrounds.
