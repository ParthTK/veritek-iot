# VERITEK — IoT Energy Monitoring Platform

Two parts, in two directories:

| | | |
|---|---|---|
| **`/` (this package)** | The dashboard | React + TypeScript + Vite + Tailwind, Recharts, React Router. Still driven entirely by local mock datasets — see [Data layer](#data-layer). |
| **[`server/`](server/)** | The backend | MQTT + HTTP ingestion, Modbus register decoding, time-series storage, rollups, device registry, alerts, live stream. Real, running, and verified end to end. |

The two are not wired together yet: the dashboard still reads
`src/services/index.ts`, which returns mock data. Pointing it at the backend
means reimplementing those functions against the APIs in
[`server/README.md`](server/README.md#apis) — the service layer was built as
exactly that seam.

## Running the dashboard

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>.

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck (`tsc -b`) then production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` only |

### Demo credentials

```
admin@veritek.com  /  Pass@123
```

Any other seeded user's email works with the same password, which is handy for
looking at the app as an Operator or Viewer. `vikram.shetty@veritek.com` is
deactivated and demonstrates the rejected-login state.

## Implemented pages

| Route | Page | From |
|---|---|---|
| `/login` | Sign in — blue brand panel, show/hide password, remember me, loading and error states | video |
| `/dashboard` | Total / online device counts, Quick Actions, recent alerts | video |
| `/devices` | My Devices — searchable, filterable device cards with selection | video |
| `/devices/:id/meters` | Energy Meters — kWh / kVAh / kVArh meter cards | video |
| `/meters/:id/overview` | Gauges (voltage, current, power factor, frequency) + Statistical Summary | video |
| `/meters/:id/voltage` | Line-to-Line Voltage area chart, legend toggles, 30-of-500 pager | video |
| `/meters/:id/current` | Current Trend + Hourly Average Current bars | video |
| `/meters/:id/energy` | Hourly (green) and Daily (blue) consumption, totals, period comparison | video |
| `/meters/:id/diagnostic` | Power-factor trend, threshold lines, health cards, diagnostic events | video |
| `/meters/:id/alerts` | Alert Settings — Create Alert Trigger form + empty state | video |
| `/data/charts` | Energy Analytics — all trends, period presets, aggregation, export | brief |
| `/data/logs` | Meter Data Logs — dense sortable table, filters, pagination, CSV/PDF | video |
| `/data/reports` | Enhanced Report Generator + Configure Unit Price modal | video |
| `/alerts` | Alerts management — tabs, filters, acknowledge / resolve, detail modal | brief |
| `/admin/devices` | Device management — CRUD table, add/edit form, enable toggle, delete confirm | brief |
| `/admin/users` | User management — roles, site/device assignment, activate/deactivate | brief |
| `/admin/thresholds` | Per-device threshold configuration with units | brief |
| `/admin/settings` | General / Notifications / System tabs, **Reset demo data** | brief |
| `/profile` | Profile details + change password | brief |

"video" = reproduced from the reference recording. "brief" = required by the written
spec but never shown in the recording, so built in the same visual language.

## Project structure

```
src/
  components/
    layout/     AppLayout, Sidebar, PageHeader (breadcrumbs), Logo
    dashboard/  GaugeCard, StatCard
    charts/     PhaseCharts, ConsumptionBarChart, SeriesLegend, ChartTooltip, palette
    tables/     DataTable (sortable, sticky column, zebra)
    ui/         Button, Card, Form, Badge, Modal, Pagination, States
  pages/        one file per route, meter tabs under pages/meter
  data/         seed.ts (fixtures), readings.ts (series generator + aggregation)
  services/     storage.ts, dataStore.ts, index.ts  ← the only backend-facing seam
  hooks/        useAuth, useToast, useStore, useChartPage, useDeviceSelection
  types/        all domain interfaces
  utils/        format, csv, cn, random
```

## Data layer

`src/services/index.ts` is the single seam a real backend would replace. Components
never touch mock data directly — they call `listDevices()`, `listReadings(meterId)`,
`setAlertStatus()` and so on. Swap those function bodies for HTTP calls and the UI is
unchanged.

- **Fixtures** (`data/seed.ts`) — 5 sites, 7 users, 6 devices, 7 meters, 8 alerts,
  5 diagnostic events. ABC Manufacturing / `EM-2000` / `GW-ABC-0001` reproduce the device
  in the recording.
- **Readings** (`data/readings.ts`) are *generated*, not stored: 500 samples per meter
  at 3-minute intervals from a per-meter seeded PRNG, so the series are identical on
  every load but differ between meters. A 24-hour load profile drives the daytime
  plateau and overnight trough seen in the reference bar charts. Occasional surges and
  voltage swells are injected deliberately so the threshold, warning and critical
  states actually occur.
- **Persistence** — device/user/alert/trigger/settings changes are written to
  `localStorage` under the `veritek.*` namespace and survive a refresh. Settings →
  System → **Reset demo data** restores the shipped fixtures (and deliberately keeps
  you signed in).

## Chart palette

The three-phase series (R / Y / B) are the categorical set and were validated with the
`dataviz` palette checker against a white surface:

| Check | Result |
|---|---|
| Lightness band | PASS |
| Chroma floor | PASS |
| CVD separation | PASS — worst adjacent pair R↔Y, deutan ΔE 10.0 |
| Normal-vision floor | PASS — ΔE 19.2 |
| Contrast vs surface | WARN — amber `#CA8A04` at 2.86:1 |

The contrast warning is discharged as the guidance requires: every chart using these
hues ships a labelled legend, and the same numbers are available as text in the Meter
Data Logs table. Colour follows the entity — phase R stays red whether or not the other
series are toggled off.

## Known limitations

- **PDF export** downloads a styled, printable HTML document rather than a real PDF;
  generating true PDFs is server work. CSV export is a genuine, correct download.
- **Change password** validates fully but does not persist — the demo password keeps
  working, and the toast says so.
- Sign-up and forgot-password are intentionally inert and explain themselves.
- The reference video is a handheld phone recording of a laptop screen at 464×832, so
  some small text was unreadable. Values inferred rather than read are marked
  **(inferred)** in `SCREEN_INVENTORY.md`.

## Reference notes

`SCREEN_INVENTORY.md` is the screen-by-screen breakdown taken from the recording —
every page, tab, card, chart, table, form, modal and interaction, plus the colour and
layout observations the implementation was built against.
