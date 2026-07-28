# Production Data System — Requirements & Architecture

**Owner:** Harsha (Production Data Manager)
**Version:** v3
**Date:** 24 July 2026

Structure: Problem → Requirements → Architecture → Implementation. Requirements are stated without reference to any specific technology, so the backend can be replaced without reopening them.

---

# 1. Problems

| # | Problem |
|---|---------|
| 1 | Daily entry is heavy on the tablet — hard lag, dead slow |
| 2 | Supervisors get thrown out of the app 10+ times per day |
| 3 | Data collection and compilation is manual and fragile |

## 1.1 Problem 1 — Lag

- **Backend latency.** Each server call costs roughly 400–1500 ms. Every config fetch, capacity check, and save pays this.
- **Workbook weight.** Six department tabs, each wide-format, with formula-driven lookups into a 1,778-row item master.
- **Phantom row bloat.** Sheets are formatted far beyond their real data:

  | Tab | Real machine rows | Sheet extends to |
  |---|---|---|
  | Forging-3 | 14 | row 971 |
  | Machining | 40 | row 1002 |
  | Forging-2 | 17 | row 968 |
  | Forging-2 TM | 6 | row 958 |
  | Rolling | 32 | row 35 |
  | Forging-1 | 18 | row 20 |

  Roughly 950 empty-but-formatted rows per affected tab, each carried in memory and recalculated.

## 1.2 Problem 2 — Being thrown out of the app

**Symptom:** Android system dialogs appear — "Sheets isn't responding", "Battery meter isn't responding" — with options to close or wait. Occurs soon after pinning, sometimes repeatedly.

**Diagnosis:** These are ANR (Application Not Responding) dialogs, raised when an app's main thread is blocked for several seconds.

1. An ANR dialog is a **system** dialog, so it breaks out of screen pinning and drops the user back to the launcher or lock screen. This is the "lock-out."
2. The battery meter is part of system UI. A system UI component ANR-ing indicates **device-wide memory and CPU exhaustion**, not a single misbehaving app.

**Root cause:** RAM and CPU pressure on a 4 GB device, driven primarily by the spreadsheet app holding the bloated workbook in memory, compounded by the browser running alongside it.

**Not the cause:** network connectivity, screen sleep, lock-screen timeout, or the app's PIN session timeout.

**Implication:** Kiosk mode, "Keep Screen On", and longer session timeouts do not fix this. The production workbook must never be opened on the tablet.

## 1.3 Problem 3 — Collection and compilation

- Wide format: every schedule slot is its own set of columns, not a row.
- One tab per department, with no common column structure between them.
- Cross-department and monthly views require manual stitching outside the templates.
- No audit trail of who entered or changed what.

---

# 2. Current Format

## 2.1 Shared structure

```
[Machine] [Operator] [Day Prod vs Capacity] [Night Prod vs Capacity]
[Day SCH-1] [Day SCH-2] … [Night SCH-1] [Night SCH-2] …
```

**Each schedule (SCH) block:** Item Code / Part Number · Item Name / Part Name (formula lookup) · Prod Qty · Reason for less production · Remarks · Part Change time Start · Part Change time End

**Each Prod vs Capacity block:** Prod (actual) · Capacity / Expected Qty · % achievement

**Shifts:**

| Shift | Timing | Duration |
|---|---|---|
| Day | 09:00 – 17:30 | 7.5 hrs |
| Night | 17:30 – 09:00 | 10 hrs |

## 2.2 Department detail

| Department | Machines | Range | Slots/shift | Notes |
|---|---|---|---|---|
| Rolling | 32 | TH-01 … TH-32 | **3** | Capacity split into `Manual` and `Auto QTY`, each with its own %. Night header reads 5:30PM–10AM. TH-19 capacity is 0. |
| Forging-1 | 18 | BH-01 … BH-18 | 2 | Supervisor Naveen. Separate day and night Operator Name columns. |
| Forging-2 | 17 | H-01 … H-17 | 2 | Single `M/C PROD vs Capacity` header covering both shifts. |
| Forging-2 TM | 6 | TM-01 … TM-05, H-06 | 2 | Tab named "Forging-2 TM-May". Adds explicit Day/Night Production Start/End columns. H-06 also appears in Forging-2. |
| Forging-3 | 14 | B-01 … B-14 | 2 | Supervisor Arvind. Explicit Day/Night Production Start/End columns. Repeats M/C # and Operator Name for the night section. |
| Machining | 40 | see below | 2 | Supervisor Ravi. Slots labelled "Part-1"/"Part-2". Uses Part Number/Part Name terminology. Capacities in hundreds–thousands. |

**Machining machine families:**

| Family | Machines |
|---|---|
| SH | SH-01 … SH-07 |
| TP | TP-01 … TP-04 |
| CNC | CNC-01 … CNC-04 |
| HAL | HAL-01 |
| TR | TR-01 … TR-08 |
| CNC: SH | CNC: SH-01, CNC: SH-02, CNC: SH-03 |
| AD | AD-01 … AD-04 |
| DL | DL-01, DL-02 |
| ADM | ADM-01 |
| GR | GR-02, Gr-03 |
| HAG | HAG-01 |
| EPG | EPG-01 … EPG-03 |

**Volume:**

| Department | Machines | Slots/shift | Max entries/day |
|---|---|---|---|
| Rolling | 32 | 3 | 192 |
| Forging-1 | 18 | 2 | 72 |
| Forging-2 | 17 | 2 | 68 |
| Forging-2 TM | 6 | 2 | 24 |
| Forging-3 | 14 | 2 | 56 |
| Machining | 40 | 2 | 160 |
| **Total** | **127** | — | **~572** |

Actual volume is lower, as not every slot runs every day.

## 2.3 Item master and the lookup

- **Tab:** `Item code & name` · **Rows:** 1,778 · **Columns:** `ITEMCODE` (numeric), `ITEMNAME` (text)
- **Examples:** `332 → 5X14 SCREW BT TYPE 1010`, `853 → M7X1.0X17 L/H`

Each SCH block holds an Item Code cell, with the adjacent Item Name cell a formula resolving the code into a name — roughly 8 lookups per machine row across 127 machines.

**On the `#REF!` values in the shared workbook:** the shared file is a template example that does not contain the linked item-master source, so lookups resolve to `#REF!`. This is an artefact of the example file, not a fault in the live system.

**Architectural cost:** resolving ~1,000 formula lookups against a 1,778-row master on every recalculation is a significant part of the workbook's weight, and it breaks whenever the master is moved, renamed, or a column is inserted.

## 2.4 Capacity values

Capacity is stored per machine per shift. Comparing day capacity ÷ 7.5 hrs against night capacity ÷ 10 hrs:

| Machine | Day cap | Rate/hr | Night cap | Rate/hr | Match |
|---|---|---|---|---|---|
| B-01 (F3) | 31,500 | 4,200 | 42,000 | 4,200 | yes |
| BH-01 (F1) | 49,500 | 6,600 | 66,000 | 6,600 | yes |
| BH-09 (F1) | 65,550 | 8,740 | 69,000 | 6,900 | no |
| BH-10 (F1) | 39,900 | 5,320 | 42,000 | 4,200 | no |
| H-04 (F2) | 25,200 | 3,360 | 52,080 | 5,208 | no |
| H-08 (F2) | 67,500 | 9,000 | 103,200 | 10,320 | no |

## 2.5 Cumulatives computed today

Per machine, per shift: `Prod` (total across that shift's slots) · `Capacity` · `%` (Prod ÷ Capacity). Rolling splits this into `Manual` and `Auto` streams.

No weekly, monthly, or cross-department roll-up exists in the workbook. Everything beyond per-machine-per-shift is compiled by hand.

---

# 3. Requirements

Technology-agnostic. These do not change if the backend is replaced.

## 3.1 Data entry

| ID | Requirement |
|---|---|
| E1 | Supervisor logs in once per shift and sees only their own department's machines |
| E2 | Select machine → shift → slot → item code → enter produced qty |
| E3 | Item name resolves automatically from the item master |
| E4 | Capture Produced Qty, Reason (from list), Remarks (free text) |
| E5 | Capture schedule Start and End times |
| E6 | Schedule slots per shift configurable per department (3 for Rolling, 2 elsewhere) |
| E7 | Rolling: capture Manual and Auto quantities separately |
| E8 | Edit an already-saved entry from the device, without admin involvement |
| E9 | Full offline operation with automatic sync on reconnect |
| E10 | Save returns instantly, with no server round-trip in the critical path |
| E11 | Block entries whose scheduled time exceeds remaining shift time |
| E12 | Operator name per machine per shift |
| E13 | Inactive machines are hidden from entry without deleting their history |

## 3.2 Automation

| ID | Requirement |
|---|---|
| A1 | Every derivable field is computed, never typed |
| A2 | Cumulatives are maintained continuously — no compilation step exists |
| A3 | Shift-end and monthly reports are generated and distributed without human action |
| A4 | Missing entries are detected and flagged automatically |
| A5 | Anomalous entries are flagged at the point of save |
| A6 | Data is backed up automatically |
| A7 | Storage growth is managed automatically |
| A8 | Report recipients are configurable without code changes |

## 3.3 Non-functional

| ID | Requirement |
|---|---|
| N1 | No ANR-driven ejections. Tablet memory footprint kept minimal |
| N2 | Runs smoothly on Lenovo Tab M11 (Helio G88, 4 GB RAM) |
| N3 | A slot entry takes well under a minute |
| N4 | Every entry and edit is attributable and timestamped |
| N5 | Routine changes are made in-app, not in code |
| N6 | Zero running cost |
| N7 | Backend is replaceable without changing the frontend contract |
| N8 | Every failure has a specific, recorded cause |

## 3.4 Data and output

| ID | Requirement |
|---|---|
| D1 | Long format, one row per schedule-slot entry |
| D2 | Single unified table across all departments |
| D3 | All cumulatives derived automatically |
| D4 | History retained and queryable by date range, department, machine, and item |
| D5 | Item Code is the stable identifier; names may change without affecting history |
| D6 | Schedule (planned) data viewable against actual production |

---

# 4. Data Architecture

## 4.1 Separation by purpose

Five stores, separated by access pattern. The hot path — config reads and log writes — stays in the primary file; the rest are separate and referenced by ID.

| Store | Contents | Access pattern |
|---|---|---|
| `Production Log` | One row per schedule-slot entry | Append + upsert by ID |
| `Config` | Machines, Supervisors, Reasons, Settings, Schedule, Recipients, Item Capacity Override | Read-heavy, rarely written |
| `Audit` | Every create and edit, before/after values | Append only, never read by the app |
| `Summary Cache` | Pre-computed rollups | Written on save, read by dashboard |
| `System Log` | Errors and authentication events only | Append only |

`System Log` deliberately excludes routine calls. Logging every save would add a write to the critical path and reintroduce the latency the design exists to remove.

## 4.2 Production Log schema

```
Entry ID (UUID) | Server Timestamp | Client Timestamp | Last Updated |
Date | Shift | Department | Machine ID | Schedule Slot |
Item Code | Qty Type | Scheduled Qty | Produced Qty | Achievement % |
Reason | Remarks | Schedule Start | Schedule End |
Operator Name | Supervisor Name | Flags
```

- **Entry ID is a UUID**, not a timestamp — collision-free across offline devices and portable across any future migration.
- **`Qty Type`** carries `Manual` / `Auto` for Rolling, blank elsewhere. This satisfies E7, which the previous single-quantity schema could not express.
- **Item Name is not stored.** Item Code is the source of truth; the name is resolved on read. Names change, codes do not.
- **`Flags`** holds automation-raised anomaly markers (see §5.1).

## 4.3 Machine configuration

```
Machine ID | Department | Display Name | Base Rate (pcs/min) |
Day Rate Override | Night Rate Override | Slots Allowed | IsActive
```

- **`Machine ID` is unique and stable.** H-06 appearing in both Forging-2 and Forging-2 TM becomes two distinct IDs (`F2-H06`, `TM-H06`) so entries are never ambiguous. Casing inconsistencies (`GR-02` / `Gr-03`) are resolved at the ID level; supervisors select from a list and never type a machine name.
- **`Slots Allowed` is per department**, replacing the single global slot cap. Rolling gets 3; the rest get 2. A Forging supervisor cannot create a slot that shouldn't exist.
- **`IsActive`** hides machines like TH-19 from entry dropdowns while preserving their history.
- **Day/Night Rate Override** are optional, for the machines whose shifts genuinely differ (BH-09, BH-10, H-04, H-08). Blank means derive both shifts from Base Rate.

## 4.4 Capacity resolution

Capacity varies by part. Resolution order, first match wins:

```
1. Item Capacity Override  (Machine ID + Item Code → pcs/min)
2. Shift Rate Override     (Day Rate / Night Rate on the machine)
3. Base Rate               (machine default)
```

`Item Capacity Override` is a separate table, populated only where a part's rate is known to differ. It starts empty. Existing base rates are carried over unchanged, so the system behaves exactly as today until an override is entered.

Scheduled quantity is always derived:

```
Scheduled Qty = (Schedule End − Schedule Start) in minutes × resolved rate
```

## 4.5 Schedule (planned) data

```
Schedule ID | Date | Department | Machine ID | Shift | Slot |
Item Code | Planned Qty | Source | Uploaded At
```

Populated by admin Excel upload — the file is parsed into rows on upload. Feeds the Schedule vs Production view (§6.3). Automating the upstream capture of this data is deferred until the entry system is live.

## 4.6 Supervisors

```
Supervisor ID | Name | PIN | Departments | IsActive
```

`Departments` accepts more than one value. Machines are filtered where the machine's department is among the supervisor's departments — covering supervisors who span departments without a schema change.

## 4.7 Sync states and error taxonomy

Queue states:

```
Queued → Sending → Synced
              ↓
           Failed → (retry with backoff)
              ↓
          Conflict → (surfaced for resolution)
```

`Conflict` arises when the same Entry ID is edited from two devices. Detection is by comparing `Last Updated` on the server against the value the device last saw; a mismatch is a conflict rather than a silent overwrite.

Every failure records a specific cause:

| Cause | Meaning |
|---|---|
| Network Error | Device could not reach the server |
| Validation Error | Rejected by a business rule (e.g. capacity) |
| Duplicate | Entry ID already present with identical content |
| Server Error | Backend fault |
| Unauthorized | Bad PIN or token |
| Config Mismatch | Device config version older than server's |

## 4.8 Configuration versioning

Config and item master carry a version number. The device stores both locally and sends its version on connect. The server responds with the full payload only when versions differ; otherwise it confirms and sends nothing.

Config is a few kilobytes, so the payload is not worth computing differences over — the saving comes from **not downloading at all** when nothing has changed. This eliminates a startup round-trip on every login.

## 4.9 Storage growth

At ~20 columns × ~570 entries/day, the Production Log grows by roughly 4.2 million cells per year. Spreadsheet backends cap at 10 million cells per file, giving roughly two to three years before the limit is reached.

Archive rotation is therefore designed in from the start, not retrofitted: a scheduled job moves closed periods to an archive file and leaves the live log holding the current window only. The dashboard reads the Summary Cache, so historical rollups survive archival.

---

# 5. Automation Layer

The organizing principle: **any step that currently requires a person becomes a trigger.**

## 5.1 On save — automatic, no human input

| # | Action |
|---|---|
| 1 | Date and shift inferred from the device clock and configured shift windows |
| 2 | Item name resolved from Item Code |
| 3 | Resolved capacity rate selected per §4.4 |
| 4 | Scheduled Qty calculated from schedule minutes × rate |
| 5 | Achievement % computed |
| 6 | Summary Cache updated incrementally — no compilation step ever runs |
| 7 | Audit row written with before/after values |
| 8 | Anomaly flags raised |

**Anomaly flags:** zero output on a running machine · achievement above 100% · capacity not configured for that machine · produced qty exceeding scheduled qty · schedule times overlapping another entry on the same machine and shift.

Flags annotate the entry; they do not block it. Blocking is reserved for the shift-time capacity rule (E11).

## 5.2 On a timer — no human involvement

| # | Job | Frequency |
|---|---|---|
| 9 | Shift-end summary compiled and emailed | Twice daily, at each shift close |
| 10 | Missing-entry sweep — machines active but unlogged this shift; nudge sent | Twice daily, before shift close |
| 11 | Monthly MIS generated and emailed | 1st of each month |
| 12 | Full data snapshot to a dated backup file | Nightly |
| 13 | Archive rotation for closed periods | Annually |
| 14 | Summary Cache integrity rebuild | Weekly |

Job 14 exists because incremental cache updates can drift if a sync fails mid-write. A weekly full recompute against the Production Log corrects any drift without anyone noticing it occurred.

## 5.3 Report distribution

Email, sent from the backend directly — no external service, no API keys, no cost.

Recipients live in a `Recipients` config table with a role column:

```
Role | Email | Reports
```

Adding GM/MD later is adding a row, not changing code. Initial state: reports go to Harsha only, for a few days of observation before wider distribution.

## 5.4 On device — automatic

| # | Action |
|---|---|
| 15 | Config and item master cached locally, version-gated per §4.8 |
| 16 | Entries queued locally; save returns instantly |
| 17 | Sync retried automatically with backoff on failure |
| 18 | Conflicts detected rather than silently overwritten |
| 19 | Config refetched in the background whenever online |

---

# 6. Dashboard & Reporting

PIN-protected, separate from the entry app. Filterable by date range and department. All figures read from the Summary Cache, so views are instant regardless of how much history exists.

## 6.1 Overview
Factory achievement % · total produced for the period · active machine count · entries flagged for attention.

## 6.2 Trends & reasons
Achievement % trend line across the selected range · loss-reason breakdown as a ranked horizontal bar chart.

## 6.3 Schedule vs Production
Planned versus actual for the selected period, from the uploaded schedule (§4.5). Variance visible per department and per machine.

## 6.4 Parts
Part-wise cumulative for a selected item code. Cross-department progress tracking is available once a routing sequence per part is defined; until then this view shows per-department quantities without an implied order.

## 6.5 Refresh
On load, with a manual refresh control, plus background polling on a slow interval. Continuous real-time updating is not used — it would exhaust backend quotas for no operational benefit.

## 6.6 Deferred to Phase 3
Live factory status board (machine cards, green/amber/red) · supervisor analytics (entries per day, edit frequency, missing entries, average delay) · machine history drill-down (30-day efficiency, downtime, operators, reasons).

These are valuable and the data to support them is already being captured. They are sequenced after the entry system is live and stable.

---

# 7. Implementation — Current Stack

This section is deliberately isolated. Nothing above depends on these choices.

| Layer | Today | Notes |
|---|---|---|
| Frontend | Static PWA on free static hosting | Installable, offline-capable, no app store |
| API | Bound script Web App, shared-secret token | The frontend contract; replaceable |
| Data | Spreadsheet files, separated per §4.1 | Item master must sit alongside the API-bound file |
| Local storage | On-device database (IndexedDB) | Config, item master, entry queue |
| Scheduling | Time-driven triggers | Drives all of §5.2 |
| Email | Backend-native mail | No third-party service |
| Cost | ₹0 | |

**Migration path:** because the frontend talks to an API rather than to a spreadsheet, moving the data layer to a hosted database later changes only the API implementation. Requirements in §3 and the schema in §4 remain as written.

## 7.1 Build disposition

The existing PWA is approximately 70% reusable. Rebuilding from scratch would discard working, debugged logic and reintroduce resolved defects.

| Keep | Refactor | Build new |
|---|---|---|
| Entry form UI | Backend split into five stores | Automation triggers (§5) |
| PIN auth and session handling | Schema: UUID, Qty Type, IsActive, Machine ID | Summary Cache |
| Capacity validation logic, including edit-time exclusion | Sync states and conflict detection | Audit and System Log |
| Offline queue skeleton | Config version-gating | Schedule upload and view |
| In-app settings screens | Capacity resolution order | Dashboard |
| Double-submit guard | Per-department slot limits | Report distribution |

**Defects already resolved and to be preserved:** text-format enforcement on PIN fields (numeric coercion silently altering values like "0000") · double-submit guard on save · exclusion of an entry's own prior time from capacity checks during edit · token preservation across backend updates.

---

# 8. Phase Plan

## Phase 1 — Entry and core automation
Schema migration (UUID, Qty Type, Machine ID, IsActive, per-department slots) · capacity resolution order with override tables · store separation · audit and system log · sync states and error taxonomy · config version-gating · on-save automation (§5.1) · shift-end summary email · nightly backup.

**Exit condition:** supervisors enter a full week with zero ejections and no manual compilation.

## Phase 2 — Visibility
Dashboard (Overview, Trends, Schedule vs Production, Parts) · Summary Cache with weekly integrity rebuild · Excel schedule upload · missing-entry sweep · monthly MIS · GM/MD added to recipients.

## Phase 3 — Intelligence
Planned-versus-actual variance alerts · automated schedule capture (replacing manual upload) · live factory status board · supervisor analytics · machine history drill-down · archive rotation activation.

---

# 9. Open Decisions

| # | Decision | Status |
|---|---|---|
| 1 | Per-part capacity | **Resolved.** Base rates retained; optional per-item override added. Overrides entered as they become known. |
| 2 | Report recipients and channel | **Resolved.** Email. Harsha only initially; GM/MD added after a few days of observation via the Recipients table. |
| 3 | Monthly planned quantity | **Resolved.** Deferred. Replaced by a Schedule table with admin Excel upload and a Schedule vs Production view. Automation of capture moves to Phase 3. |
| 4 | Department routing order per part | Open. Blocks cross-department sequencing in §6.4 only. |
| 5 | Rolling night shift end — 09:00 or 10:00 | **Resolved.** Night shift is contiguous with Day (17:30→09:00, no gap); Day starts 09:00. |
| 6 | Machining naming — are SH-01 and CNC: SH-01 distinct machines; is there a GR-01 | **Resolved.** SH-01 and CNC: SH-01 are distinct machines (`MC-SH01` vs `MC-CNCSH01`). No GR-01 confirmed. |
| 7 | Is Forging-2 TM permanent | **Resolved.** Forging-2 TM is a real, permanent department (Machine IDs prefixed `TM-`). H-06 belongs to it exclusively — removed from Forging-2's machine list; qty never rolls into Forging-2 production totals. Forging-2's true machine count is 16, not 17. |
| 8 | Number of tablets — per department or per supervisor | Open. Multi-department supervisor support is built either way. |
| 9 | Manual/Auto capacity split for Rolling | **Resolved.** Manual rows carry an ad-hoc capacity rate entered with that entry, not a resolved machine rate — the supervisor supplies it at entry time. Auto rows continue to use `resolveRate()` (Item Override → Shift Override → Base Rate) as normal. No second rate column needed on the Machines sheet. |
| 10 | IndexedDB/Dexie migration | Open. Hard constraint requires IndexedDB via Dexie for the entry queue, config cache, and item master — current implementation still uses localStorage for all of these. Deliberately not migrated in this round; flagged as its own dedicated task given how foundational storage is to correctness. |

## 9.1 Rejected suggestions

| Suggestion | Reason for rejection |
|---|---|
| Event sourcing (store events, derive state) | Turns every read into a replay for no benefit at this volume. The Audit store already preserves full history. |
| Delta-based config sync | Config is a few kilobytes. Version-gating avoids the download entirely, which is strictly better than computing differences. |
| PIN + device binding | Locks a supervisor out when a tablet fails or they cover another department. Device ID is recorded on each entry instead, giving the same accountability without the failure mode. |
| Logging every API call | Adds a write to the critical path, reintroducing the latency this design exists to remove. Errors and auth events are logged; routine calls are not. |
