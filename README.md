# CopilotWatchTower (코파일럿 워치타워)

> **Microsoft 365 Copilot usage & conversation collection tool for tenant admins.**
> The main app is an **Electron** (electron-vite + React + TypeScript) desktop app.
>
> 테넌트 관리자를 위한 **Microsoft 365 Copilot 사용 현황·대화 수집 도구**.
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

### Other commands

| Command | Description |
| --- | --- |
| `npm run dev` | Dev mode (main+renderer, HMR) |
| `npm run build` | Production bundle build (`out/`) |
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

### 그 외 명령

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 개발 모드 (메인+렌더러, HMR) |
| `npm run build` | 프로덕션 번들 빌드 (`out/`) |
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
