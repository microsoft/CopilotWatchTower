# CopilotWatchTower

> Microsoft 365 Copilot **enterprise interaction** collector for tenant administrators — built with Python + PySide6.

Repository: <https://github.com/microsoft/CopilotWatchTower>

CopilotWatchTower lets an authorised Microsoft 365 administrator collect the raw
Copilot interaction history (`/beta/copilot/users/{id}/interactionHistory/getAllEnterpriseInteractions`) for every user in their tenant, store it locally, and explore / export it for compliance and analytics scenarios. The whole tool runs on the admin's own workstation; no inbound network endpoint is required.

> ⚠️ **Compliance disclaimer.** This tool reads Copilot conversation bodies in plaintext. Use it only in tenants where you have explicit legal authority to do so (eDiscovery, internal audit, regulatory archive, etc.). Review your DPIA and data-handling policy before deploying.

---

## Features

- **Zero pre-registration.** The first launch runs a guided wizard that
  registers a new Entra ID application in your tenant via MSAL device
  code flow (using the well-known Microsoft Graph PowerShell client), grants
  the `AiEnterpriseInteraction.Read.All`, `User.Read.All` and
  `Organization.Read.All` **application** permissions, opens the admin
  consent URL in your browser, and persists the client secret with
  Windows DPAPI.
- **Tenant-wide collection** by user enumeration with four scope modes:
  - `LICENSED` — Copilot-licensed users (default, recommended)
  - `ALL_ACTIVE` — every enabled user in the tenant
  - `GROUP` — members of a specific Entra group
  - `CUSTOM` — explicit UPN list
- **Resilient & incremental.** Per-user watermark (`createdDateTime` filter)
  with a 300-second safety margin; honours `Retry-After`; exponential
  backoff; idempotent upserts so re-runs never duplicate.
- **Local-only SQLite store** at `%LOCALAPPDATA%\CopilotWatchTower\store.db`,
  with FTS5 full-text search over conversation bodies.
- **Modern Qt UI** — Dashboard (KPIs + charts), Conversations browser,
  live Monitoring tab with collection log, and CSV/JSON/XLSX exporter.
- **Localized** Korean / English (Qt Linguist `.ts` files).

---

## Quick start (developer mode)

```powershell
# 1. Create a venv with Python 3.11+
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. Install in editable mode with dev extras
pip install -e ".[dev]"

# 3. Run
copilot-watchtower
#   …or:  python -m copilot_watchtower
```

On first launch the **Onboarding Wizard** walks you through:

1. **Device code** — sign in as a tenant administrator who can grant
   admin consent (Global Administrator, Privileged Role Administrator,
   Cloud Application Administrator, or Application Administrator).
2. **App registration** — the tool POSTs to `/applications`, creates a
   service principal, and adds a 180-day client secret.
3. **Admin consent** — your browser opens the consent prompt; the tool
   listens on a random loopback port for the callback.
4. **Done** — the wizard stores `tenant_id`, `client_id`, the
   DPAPI-protected secret, and flags bootstrap as complete.

Subsequent launches go straight to the main window and resume polling.

---

## Building a Windows MSIX

```powershell
pip install pyinstaller
pyinstaller packaging\copilot-watchtower.spec --clean --noconfirm
# Place dist\CopilotWatchTower\* together with packaging\AppxManifest.xml
# and your Assets\ folder, then:
makeappx pack /d msix-staging /p CopilotWatchTower.msix
signtool sign /fd SHA256 /a CopilotWatchTower.msix
```

Edit `packaging/AppxManifest.xml` to match your code-signing certificate's
subject before packaging for production distribution.

---

## Required Microsoft Graph permissions

| Permission                              | Type        | Why                                       |
| --------------------------------------- | ----------- | ----------------------------------------- |
| `AiEnterpriseInteraction.Read.All`      | Application | Read every user's Copilot interactions    |
| `User.Read.All`                         | Application | Enumerate users and Copilot licensees     |
| `Organization.Read.All`                 | Application | Read subscribed SKUs to identify Copilot  |
| `Application.ReadWrite.All` (delegated) | Delegated   | Bootstrap: create the app registration    |
| `AppRoleAssignment.ReadWrite.All` (delegated) | Delegated | Bootstrap: assign the app permissions |
| `Directory.Read.All` (delegated)        | Delegated   | Bootstrap: read tenant info               |

---

## Data location & retention

| Item              | Path                                                |
| ----------------- | --------------------------------------------------- |
| SQLite DB (+WAL)  | `%LOCALAPPDATA%\CopilotWatchTower\store.db`         |
| App logs          | `%LOCALAPPDATA%\CopilotWatchTower\logs\app.log`     |
| Audit log         | `%LOCALAPPDATA%\CopilotWatchTower\logs\audit.log`   |

Use **Settings → 위험 영역 → 앱 등록 및 데이터 삭제** to wipe stored credentials.
The Entra ID app registration itself must be removed manually from
[Entra portal → App registrations](https://entra.microsoft.com/).

---

## Tests

```powershell
pip install -e ".[dev]"
pytest -q
```

Tests cover the repository (CRUD + FTS), DPAPI round-trip, exporter formats,
and the Graph client retry/pagination logic via `httpx.MockTransport`.

---

## Architecture

```
┌───────────────────────────────┐
│ PySide6 UI (main thread)      │
│  ├─ MainWindow / sidebar      │
│  ├─ Dashboard (QtCharts)      │
│  ├─ Conversations (FTS)       │
│  ├─ Monitoring (live log)     │
│  └─ Export                    │
└──────────────┬────────────────┘
               │ signals/slots
┌──────────────▼────────────────┐
│ CollectorWorker (QThread)     │
│  ├─ resolve scope             │
│  ├─ per-user list_interactions│
│  └─ batched upserts           │
└──────────────┬────────────────┘
               │
┌──────────────▼────────────────┐  ┌──────────────────────────┐
│ GraphClient (httpx)           │  │ Repository (SQLite+FTS5) │
│  retry / pagination / 429     │  │ DPAPI-protected secrets  │
└───────────────────────────────┘  └──────────────────────────┘
```

---

## License

MIT — see [LICENSE](LICENSE).
