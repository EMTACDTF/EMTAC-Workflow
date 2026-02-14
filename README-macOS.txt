# EMTAC WORKFLOW – macOS clickable app setup

This project is already configured to build a clickable macOS app (.app) and DMG.

## 1) Install dependencies (once)
In Terminal, in this folder:
```bash
npm install
```

## 2) Build the macOS app (creates dist/)
```bash
npm run dist
```

## 3) Install / launch
Open the `dist` folder:
- `EMTAC WORKFLOW.dmg` → drag **EMTAC WORKFLOW** into Applications
- Then launch from Applications (no Terminal needed)

## Notes
- The app icon is included at `build/icon.icns`.
- If Gatekeeper blocks it, right-click the app → Open → Open.
