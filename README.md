# CopilotWatchTower (코파일럿 워치타워)

> **Local observability and forensic workstation for Microsoft 365 Copilot tenant admins.**
> The main app is an **Electron** (electron-vite + React + TypeScript) desktop app.
>
> 테넌트 관리자를 위한 **Microsoft 365 Copilot 로컬 관찰·증적 수집·포렌식 워크스테이션**.
> 메인 앱은 **Electron**(electron-vite + React + TypeScript) 데스크톱 앱입니다.

Repository / 리포지토리: <https://github.com/microsoft/CopilotWatchTower>

**[English](#english)** | **[한국어](#한국어)**

---

## English

### Quick start (Electron)

Requirements: Node.js 20+ (bundles Electron 42 / Node 24), Windows.

```powershell
# Install dependencies (first time only)
npm ci

# Run in dev mode (electron-vite dev + HMR)
npm run dev
```

Or use the launcher script at the repo root:

```powershell
.\run.ps1      # or run.bat
```

The launcher runs `npm ci` first if `node_modules` is missing, then starts the app with `npm run dev`.

### Product scope

CopilotWatchTower runs on an administrator's Windows workstation and collects Microsoft 365 Copilot,
Copilot Studio, and Power Platform evidence for authorized investigation and analysis. It is not a
centralized multi-operator governance service and does not enforce tenant policy, revoke licenses, or
isolate agents. It does not monitor GitHub Copilot IDE usage or code suggestions.

### Data and security boundaries

- Collected data is stored per profile in SQLite under
	`%LOCALAPPDATA%\CopilotWatchTower\profiles\<profile-id>\store.db`.
- Conversation bodies, attachment metadata, audit payloads, and raw JSON are stored as plaintext so
	SQLite FTS5 and local analytics can query them.
- Client secrets, the optional browser-automation password, and the delegated MSAL token cache are
	protected with Windows DPAPI for the current Windows user. DPAPI does not encrypt collected content.
- The app has no CopilotWatchTower-operated ingestion backend. It connects directly to Microsoft Graph,
	Purview, Power Platform, and Dataverse. Normal Microsoft service telemetry and audit behavior still apply.
- Database backups and CSV/JSON exports are outside the app's DPAPI boundary and must be protected by the
	operator. Use a dedicated administrator workstation, Windows access controls, and BitLocker.

Authentication is intentionally mixed. Routine Graph collection uses app-only client credentials;
eDiscovery uses delegated authentication; PPAC and Dataverse collectors use browser automation and captured
Microsoft service tokens. eDiscovery creates or reuses Purview cases, searches, and exports, so it is not a
read-only operation. Beta, unofficial, and browser-driven collectors may be affected by Microsoft API/UI,
MFA, or Conditional Access changes.

### Other commands

| Command | Description |
| --- | --- |
| `npm run dev` | Dev mode (main+renderer, HMR) |
| `npm run build` | Production bundle build (`out/`) |
| `npm test` | Run Electron unit and IPC contract tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with V8 coverage |
| `npm run typecheck` | `tsc --noEmit` type check |
| `npm run preview` | Preview the built app |
| `npm run dist` | Build the portable Windows executable (`dist/`) |

### Languages

The app UI supports 5 languages — Korean (default), English, Japanese, Simplified Chinese, and
Spanish — via a language picker in the top bar (instant switch, no restart needed).

### Folder structure

```
src/          Electron app source (main / preload / renderer)
resources/    Icons, schema.sql, and other app resources
out/          Build output (git-ignored)
docs/         Screenshots · landing page
legacy/       Old Python (PySide6) app — reference only, will be removed
```

### About the legacy (Python) app

The PySide6 app in `legacy/` is **no longer maintained and kept only as a reference** for source
and logic. The Electron version has ported all the same functionality, and `legacy/` will
eventually be deleted.

To run it anyway:

```powershell
cd legacy
pip install -e .
copilot-watchtower
```

---

> ⚠️ **Compliance notice.** This tool collects Copilot conversation content in plain text.
> Only use it in a tenant where you have clear legal and policy authorization to do so.

---

## 한국어

### 빠른 시작 (Electron)

요구사항: Node.js 20+ (Electron 42 / Node 24 번들), Windows.

```powershell
# 의존성 설치 (최초 1회)
npm ci

# 개발 모드 실행 (electron-vite dev + HMR)
npm run dev
```

또는 루트의 런처 스크립트:

```powershell
.\run.ps1      # 또는 run.bat
```

런처는 `node_modules`가 없으면 `npm ci`를 먼저 실행한 뒤 `npm run dev`로 앱을 띄웁니다.

### 제품 범위

CopilotWatchTower는 관리자의 Windows PC에서 실행되며, 권한 있는 조사와 분석을 위해 Microsoft 365
Copilot, Copilot Studio, Power Platform 증적을 수집합니다. 다수 운영자가 사용하는 중앙 거버넌스
서비스가 아니며 테넌트 정책 집행, 라이선스 회수, 에이전트 격리를 수행하지 않습니다. GitHub Copilot
IDE 사용량이나 코드 제안도 수집하지 않습니다.

### 데이터와 보안 경계

- 수집 데이터는 프로필별 SQLite 파일
	`%LOCALAPPDATA%\CopilotWatchTower\profiles\<profile-id>\store.db`에 저장됩니다.
- 대화 본문, 첨부 메타데이터, 감사 payload, 원본 JSON은 SQLite FTS5 검색과 로컬 분석을 위해
	평문으로 저장됩니다.
- client secret, 선택적 브라우저 자동화 비밀번호, 위임 MSAL token cache는 현재 Windows 사용자 범위의
	DPAPI로 보호됩니다. DPAPI는 수집된 콘텐츠를 암호화하지 않습니다.
- CopilotWatchTower가 운영하는 별도 수집 서버는 없습니다. 앱이 Microsoft Graph, Purview, Power
	Platform, Dataverse에 직접 연결하며 Microsoft 서비스 자체의 telemetry와 감사 동작은 적용됩니다.
- DB 백업과 CSV/JSON export 파일은 앱의 DPAPI 보호 범위 밖입니다. 전용 관리자 PC, Windows 접근
	제어, BitLocker 사용을 권장합니다.

인증 방식은 의도적으로 혼합되어 있습니다. 일반 Graph 수집은 app-only client credentials,
eDiscovery는 delegated 인증, PPAC와 Dataverse 수집은 브라우저 자동화와 Microsoft 서비스 token
capture를 사용합니다. eDiscovery는 Purview case, search, export를 만들거나 재사용하므로 read-only
작업이 아닙니다. Beta, 비공식, 브라우저 기반 수집기는 Microsoft API/UI, MFA, Conditional Access
변경의 영향을 받을 수 있습니다.

### 그 외 명령

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 개발 모드 (메인+렌더러, HMR) |
| `npm run build` | 프로덕션 번들 빌드 (`out/`) |
| `npm test` | Electron 단위·IPC contract 테스트 실행 |
| `npm run test:watch` | 테스트 watch 모드 실행 |
| `npm run test:coverage` | V8 coverage와 함께 테스트 실행 |
| `npm run typecheck` | `tsc --noEmit` 타입 검사 |
| `npm run preview` | 빌드 결과 미리보기 |
| `npm run dist` | 포터블 Windows 실행 파일 빌드 (`dist/`) |

### 다국어 지원

앱 UI는 한국어(기본)·English·日本語·简体中文·Español 5개 언어를 지원하며, 상단 바의 언어
선택기에서 재시작 없이 즉시 전환할 수 있습니다.

### 폴더 구조

```
src/          Electron 앱 소스 (main / preload / renderer)
resources/    아이콘, schema.sql 등 앱 리소스
out/          빌드 산출물 (git 무시)
docs/         스크린샷 · 랜딩 페이지
legacy/       구 Python(PySide6) 앱 — 참고용, 향후 제거 예정
```

## legacy (Python) 안내

`legacy/`의 PySide6 앱은 **더 이상 사용하지 않으며 소스·로직 참고용으로만** 남아 있습니다.
Electron 버전이 동일 기능을 모두 포팅했고, legacy는 언젠가 삭제됩니다.

참고로 실행하려면:

```powershell
cd legacy
pip install -e .
copilot-watchtower
```

---

> ⚠️ **컴플라이언스 주의.** 이 도구는 Copilot 대화 내용을 평문으로 수집합니다.
> 명확한 법적·정책적 권한이 있는 테넌트에서만 사용하세요.
