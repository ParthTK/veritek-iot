# VERITEK IoT Platform — Reference Video Screen Inventory

Source: `WhatsApp Video 2026-08-13 at 1.27.31 AM.mp4` — 205s, 464×832 portrait,
handheld phone camera pointed at an ASUS Vivobook laptop screen (Chrome, Windows 11).
Frames extracted with ffmpeg at 4s intervals, upscaled 2.5× + sharpened.

Because the capture is a camera-of-a-screen at low resolution with glare and motion
blur, small text was inferred from context where unreadable. Inferred items are marked
**(inferred)**.

---

## 1. Product identity

| Item | Value |
|---|---|
| Product name | **VERITEK** |
| Logo | Outlined rounded-square chip/IC glyph + `VERITEK` wordmark |
| Tagline (under wordmark) | "Embedding For The Future" *(inferred — small italic serif-ish)* |
| Login hero heading | "IoT Solutions Platform" |
| Customer / tenant in demo | **ONIDA** |
| Device in demo | `MFM443TX`, device type "Energy Monitoring System (EMS)" |
| Device/SIM id | `TN-8623600786286128` |

---

## 2. Global design observations

- Page background: white → very light grey. Content area is plain white.
- Sidebar: white, ~230px, hairline right border. No dark theme anywhere.
- Primary blue: strong, saturated — approx `#1D4ED8`/`#1A56DB`. Used for the SIGN IN
  button, active tab pills, the Logout button, the "Create Alert Trigger" banner,
  and primary numeric column text.
- Active sidebar item: pale blue/lavender fill behind the row, blue icon + blue label.
- Cards: white, 1px light-grey border, small radius (~8px), little or no shadow.
- Typography: system sans. Page titles ~24px semibold with a leading icon.
  Table and form text is small and dense (12–13px).
- Status colours: green = online/healthy, amber/orange = warning, red = critical.
- Three-phase colour convention used consistently: **R = red, Y = amber/yellow, B = blue**.

---

## 3. Sidebar navigation

Confirmed by cropping and upscaling the nav region (frames t013/t019/t033):

```
VERITEK (logo + tagline)
─────────────────────────
▣  Dashboard
▤  My Devices
▥  Data & Logs          ← expandable group, highlighted when active
     ↳ Charts
     ↳ Logs
     ↳ Reports
🔔  Alerts
─────────────────────────
ONIDA
<second small grey line>
[ ⇥ Logout ]  ← full-width blue button
```

Before a device is selected the sidebar shows only Dashboard / My Devices / Alerts.
"Data & Logs" and its children appear once a device is opened (frames t004/t005 vs t007+).

There is **no top header bar and no profile/avatar dropdown**. Account identity and
logout live at the bottom of the sidebar. A "Last updated: HH:MM:SS AM" indicator with a
calendar/clock icon sits at the top-right of the meter detail pages.

---

## 4. Screens

### 4.1 Login (t001)
Centred card on light background, split into two columns.

- **Left column** — solid blue panel: VERITEK logo lockup, heading "IoT Solutions
  Platform", one line of supporting copy *(inferred: "Monitor and manage your devices
  with ease")*. Faint circular decorative shapes bottom-right.
- **Right column** — white panel:
  - "Welcome!" (large, bold)
  - "Sign in to your account" (grey sub-line)
  - Email field, leading icon, value/placeholder `admin@veritek.com`
  - Password field, leading lock icon, placeholder "Enter Password", trailing eye toggle
  - Full-width blue **SIGN IN** button (uppercase)
  - Full-width outlined **Sign Up** button

No "remember me" and no "forgot password" link is visible in the capture.

### 4.2 Dashboard (t003–t005)
- Page title "Dashboard".
- Two stat cards side by side:
  - `TOTAL DEVICES` — value `1`, sub-label "All time devices connected", faded icon right.
  - `ONLINE DEVICES` — value `1`, sub-label "Active in last 10 minutes", green accent.
- Section header "⚡ Quick Actions".
- Quick-action tiles in a grid, each an icon over a title + sub-line:
  - **My Devices** (blue chip icon) — "View all devices"
  - **Alerts** (yellow bell icon) — "Manage alerts"
  - **EMS Data** (green icon) — "View live data" *(label partly inferred)*

### 4.3 My Devices (t006)
Card per device:
- Device / SIM id with pin icon: `TN-8623600786286128`
- Small green badge (`SIM`/`EMS`)
- Site name with pin icon: `ONIDA`
- Green `ONLINE` pill, top-right
- Two mini tiles inside the card: **Modem** = `1`, **Last Updated** = time (green icon)
- Full-width blue button to open the device

### 4.4 Energy Meters (t007–t011)
- Header: `←` back arrow + blue lightning icon + "Energy Meters".
- One card per meter, clickable:
  - Meter name `MFM443TX` (small, grey, top-left) and a lightning glyph top-right
  - Large primary value `4265.71` with unit `kWh`
  - Secondary row: `4532.72 kVAh` · `1213.85 kVArh`
  - Clock icon + timestamp `11/22/2025, 11:32 AM`

### 4.5 Meter detail — tab bar
Present on every meter sub-page. Pill tabs, active = solid blue with white text:

`🏠 Overview` · `⚡ Voltage` · `∿ Current` · `⚡ Energy` · `⏻ Diagnostic` · `🔔 Alerts`

Title format: `← <icon> MFM443TX - <Tab>`. Top-right shows `Last updated: 10:21:32 AM`.

### 4.6 Overview tab (t013–t015)
Row of semicircular gauge cards:

| Card | Value | Arc colour | Per-phase row |
|---|---|---|---|
| VOLTAGE-LL | `394.7 V` | amber | R 393.4V · Y 392.0V · B 398.7V |
| CURRENT | `17.4 A` | grey (near-empty) | R 19.1A · Y 24.1A · B 9.2A |
| POWER FACTOR | `1.01` | green | R 1.08 · Y 1.00 · B … |

Below: **📊 Statistical Summary** — grouped min/max/average blocks:
- ⚡ Voltage (V): Maximum `443.67 V`, Minimum `368.52 V`, Average `405.78 V`
- ∿ Current (A): Maximum `151.45 A`, Minimum `0.00 A`, Average `32.02 A`
- ∿ Power Factor: Maximum `1.970`, Minimum `0.000`, Average `0.741`

### 4.7 Voltage tab (t017–t019)
- Card "⚡ Line-to-Line Voltage", y-axis labelled "Voltage (V)".
- Legend as circular toggles: `VRY (R-Y)`, `VYB (Y-B)`, `VBR (B-R)`.
- Stacked/overlapping **area** chart with small dot markers — one blue series over a pale
  blue fill, two red/amber series over a peach fill.
- X axis: timestamps `Nov 22, 10:04 AM` … `Nov 22, 10:19 AM`.
- Footer: `‹ Previous` — "Showing 1-30 of 500" — `Next ›`. Later frame shows
  "Showing 211-240 of 500", so paging works in 30-row pages.

### 4.8 Current tab (t021–t023)
- Card "∿ Current Trend (IR / IY / IB)" with legend toggles `IR`, `IY`, `IB`.
- Line/area chart with peach fill, same 30-of-500 pager.
- Second card: **📊 Hourly Average Current (Last 24 Hours)** — vertical **blue** bars,
  legend swatch "Avg Current (A)", y-axis "Current (A)", x-axis hourly `11 AM … 7 AM`.

### 4.9 Energy tab (t024–t028)
- Card **📊 Hourly Energy Consumption (Last 24 Hours)** — vertical **green** bars,
  legend "kWh (per hour)", y-axis "kWh", x-axis hourly.
  Dark hover tooltip observed: `2 AM / kWh (per hour): 2.5x`.
- Card **📊 Daily Energy Consumption (Last 7 Days)** — vertical **blue** bars,
  legend "kWh per day".

### 4.10 Diagnostic tab (t029–t031)
- Card "📊 Power Factor (PF-R, PF-Y, PF-B)" with legend toggles `PF-R`, `PF-Y`, `PF-B`.
- Three plain line series with dot markers, no fill, flatter traces.
- Same "Showing 1-30 of 500" pager.

### 4.11 Alerts tab → Alert Settings (t032–t036)
Title `🔔 MFM443TX - Alert Settings`.

- Blue full-width banner heading the card: "⚙ Create Alert Trigger" (white text).
- Form row:
  - **Metric \*** — select. Opened options are grouped:
    - *Current*: `I_R (Current R)`, `I_Y (Current Y)`, `I_B (Current B)`
    - *Power*: `KW_R (Power R)`, `KW_Y (Power Y)`, `KW_B (Power B)`
    - *Power Factor*: `PF_R (Power Factor R)`, `PF_Y`, `PF_B`
    - *Other*: `Frequency`, `kWh (Energy)`, `kVAh`, `kVArh`
  - **Condition \*** — select, value "Above Threshold"
  - **Threshold Value \*** — number input, placeholder "e.g. 440.5"
  - **Email Notification** toggle + **Email Address** field
- Empty state below: struck-through bell icon, "**No Triggers Configured**",
  "Create your first alert trigger using the form above."

### 4.12 Meter Data Logs (t038–t040)
Title `⊞ Meter Data Logs`, "Last updated" top-right.

Dense sortable table (every header carries a ⇅ affordance). Columns observed:

`Time` · `Device` · `kWh` · `kVAh` · `kVArh` · `VRN (V)` · `VYN (V)` · `VBN (V)` ·
`VRY (V)` · `VYB (V)` · `VBR (V)` …

Numeric colour coding: **kWh blue**, VRN/VYN/VBN dark grey, **VRY red**, **VYB amber**.
Rows are compact with subtle zebra striping. Sample values: kWh `4266.08 → 4263.68`
descending, kVAh `4533.15`, kVArh `1213.81`, VRN `229.80`, VRY `392.00`, VYB `392.04`.

### 4.13 Report Generator (t041–t051)
Title "Enhanced Report Generator" *(inferred)* / "Report Configuration".

- **Device Information** block: Device Name `MFM443TX`, Device Type
  `Energy Monitoring System (EMS)`, Customer `ONIDA`.
- **Current Settings** block (blue heading): Date Range `Last 30 Days`,
  Report Type `Raw Data Report`.
- **Quick Time Range Selection** — radio cards, each with a coloured calendar icon:
  `Last 24 Hours` · `Last 7 Days` · `Last 30 Days` (selected: blue ring + blue border) ·
  `Custom Range`.
- **Report Type Options** — radio cards:
  - `Raw Data Report` — "Complete list of technical columns"
  - `Analytical Report` — "Statistical analysis with charts"
  - `Consumption & Cost` — "Energy billing report"
- **Export Format** — two large cards: **Export to CSV** (green CSV glyph,
  "Comma-separated values file", green ✓ badge when selected) and **Export to PDF**
  (red PDF glyph, "Portable document format").
- Selecting *Consumption & Cost* changes Report Type to "Consumption & Cost Analysis"
  and Date Range to an explicit `10/23/2025 to 11/22/2025`.

### 4.14 Configure Unit Price modal (t045)
Centred modal over a dimmed page, white, rounded, `✕` close top-right.

- Title "₹ Configure Unit Price"
- Info line: "This price will be used to calculate the total cost in your
  Consumption & Cost report"
- Label "Price per kWh (₹)", input group: blue `₹` prefix, value `8.5`,
  blue `per kWh` suffix
- Helper: "Default: ₹8.50 per unit"
- Buttons: grey `✕ Cancel`, green `✓ Apply Price`

---

## 5. Interactions demonstrated

- Sign in → Dashboard
- Quick action / sidebar → My Devices → device card → Energy Meters → meter card → Overview
- Switching all six meter tabs
- Chart legend toggles (circular checkboxes per series)
- Chart pagination (Previous / Next, 30 rows per page of 500)
- Bar-chart hover tooltip (dark rounded box, series name + value)
- Table column sort affordances
- Metric select opened showing grouped options
- Report type / date range / export format radio selection
- Modal open, edit value, Cancel / Apply
- Back arrows on every sub-page

## 6. Not shown in the video

The written brief asks for several areas the capture never displays: device CRUD
admin, user management, notification settings, profile & change password, threshold
configuration screens, diagnostics health cards, and a full alerts list/table with
acknowledge/resolve. These are built in the same visual language established above,
using the same card, form, table and tab primitives.
