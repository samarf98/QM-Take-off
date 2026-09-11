# QM Takeoff — One-Click Room Area Tool

A full-stack PDF takeoff tool: upload a floor plan, click inside any room to
get its area, name it, and build a running takeoff table — inspired by the
"bucket-fill" measurement workflow used in tools like Kreo 2D Takeoff.

## Features

- **One-Click Area** — click inside a room; wall boundaries are detected
  automatically, ignoring gridlines and dimension lines
- **Wall-aware detection** — filters out colored/thin lines and bridges
  small gaps in dashed wall linetypes (common in real architectural PDFs),
  without sealing genuine door/window openings
- **Auto scale detection** — reads a "1:100"-style scale label straight
  from the PDF; falls back to manual two-point calibration
- **Takeoff table** — editable room names, running total area, CSV export
- **Save/reopen drawings** — projects persist with all room markings intact

## Why this is more than a flood fill

A naive click-to-fill only checks pixel darkness. Real architectural PDFs
use colored gridlines, thin dimension lines, and — as tested against an
actual ground floor plan — walls drawn with **dashed linetypes** that leak
straight through a naive fill. This tool adds:

1. Color/saturation filtering (ignores colored gridlines)
2. Local thickness filtering (ignores hairline dimension lines)
3. Morphological gap-bridging (closes small dash gaps in wall lines while
   leaving real door/window openings untouched)

## Tech Stack

- Backend: Node.js, Express, Multer
- Frontend: HTML, CSS, vanilla JavaScript, PDF.js
- Storage: local JSON + local disk (see note below)

## Run locally

```
npm install
npm start
```

Then open http://localhost:3000

## Deployment note

This uses local disk storage for saved projects and uploaded PDFs. On
Render's free/starter tier, local disk is wiped on every redeploy — attach
a persistent disk, or migrate to a database, before relying on saved data
long-term.
