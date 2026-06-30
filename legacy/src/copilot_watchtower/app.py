"""Application entry point and bootstrap orchestration."""
from __future__ import annotations

import json
import logging
import os
import sys
from importlib import resources
from pathlib import Path

from PySide6.QtCore import QLocale, QtMsgType, qInstallMessageHandler
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication

from . import __app_name__
from .config import (
    DEFAULT_POLL_INTERVAL_MINUTES,
    AppPaths,
    RuntimeOptions,
    normalize_language,
)
from .db import Repository, initialize
from .i18n import set_active_language
from .logging_setup import configure_logging
from .profiles import Profile, ProfileRegistry
from .security import unprotect
from .services import AppOnlyTokenProvider, AppRegistrar, GraphClient
from .ui.onboarding_wizard import OnboardingWizard
from .webshell import WebShellWindow

log = logging.getLogger(__name__)

# Retained for tooling that still passes the flag; both are now no-ops
# because the web shell is the only main UI.
_WEB_SHELL_FLAGS = ("--web", "--web-shell")


def _install_crash_handlers() -> None:
    """Route Python and Qt uncaught errors into the rotating log file.

    With ``pythonw.exe`` (the gui-script entry on Windows) stderr is
    discarded, so a silent crash leaves no trace. This handler makes
    sure we always have a stack in ``%LOCALAPPDATA%/CopilotWatchTower/
    logs/app.log``.
    """

    def _excepthook(exc_type, exc, tb):
        log.critical("Uncaught exception", exc_info=(exc_type, exc, tb))

    sys.excepthook = _excepthook

    # Threads created via threading.Thread also need their own hook
    # (added in 3.8). QThread workers run user code via QObject slots,
    # which use the main excepthook \u2014 but cover threading just in case.
    try:
        import threading

        def _thread_excepthook(args: threading.ExceptHookArgs) -> None:
            log.critical(
                "Uncaught exception in thread %s",
                args.thread.name if args.thread else "?",
                exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
            )

        threading.excepthook = _thread_excepthook  # type: ignore[assignment]
    except Exception:
        pass

    _LEVEL = {
        QtMsgType.QtDebugMsg: logging.DEBUG,
        QtMsgType.QtInfoMsg: logging.INFO,
        QtMsgType.QtWarningMsg: logging.WARNING,
        QtMsgType.QtCriticalMsg: logging.ERROR,
        QtMsgType.QtFatalMsg: logging.CRITICAL,
        QtMsgType.QtSystemMsg: logging.WARNING,
    }
    qt_log = logging.getLogger("Qt")

    def _qt_message_handler(mode, context, message):  # noqa: ANN001
        qt_log.log(_LEVEL.get(mode, logging.WARNING), "%s", message)

    qInstallMessageHandler(_qt_message_handler)


def _detect_system_language() -> str:
    """Best-effort OS UI language as a supported code (first-run default).

    Uses Qt's locale (``ko_KR``, ``en_US``, …) when a ``QApplication`` is
    available and falls back to the C locale otherwise. The result is run
    through :func:`detect_initial_language`, so a Korean system yields Korean
    and every other locale (English, Japanese, German, …) yields English.
    """
    raw = ""
    try:
        raw = QLocale.system().name()
    except Exception:
        raw = ""
    if not raw:
        try:
            import locale

            raw = locale.getdefaultlocale()[0] or ""
        except Exception:
            raw = ""
    return normalize_language(raw)


def _load_options(repo: Repository) -> RuntimeOptions:
    """Recreate :class:`RuntimeOptions` from persisted settings."""
    poll_raw = repo.get_text_setting("poll_interval_minutes")
    poll = int(poll_raw) if poll_raw else DEFAULT_POLL_INTERVAL_MINUTES
    scope = repo.get_text_setting("scope_mode") or "LICENSED"
    group_id = repo.get_text_setting("scope_group_id")
    upns_raw = repo.get_text_setting("scope_upns")
    upns: list[str] = []
    if upns_raw:
        try:
            upns = list(json.loads(upns_raw))
        except json.JSONDecodeError:
            upns = []
    stored_language = repo.get_text_setting("language")
    if stored_language:
        language = normalize_language(stored_language)
    else:
        # First run for this profile: adopt the OS UI language (Korean
        # unless the system is clearly English) and persist the choice so
        # the auto-detection only happens once.
        language = _detect_system_language()
        repo.set_text_setting("language", language)
    auto_backup_enabled = (repo.get_text_setting("auto_backup_enabled") or "0") in {"1", "true", "True"}
    auto_backup_mode = (repo.get_text_setting("auto_backup_mode") or "new").strip().lower() or "new"
    credit_auto_collect_enabled = (
        repo.get_text_setting("credit_auto_collect_enabled") or "0"
    ) in {"1", "true", "True"}
    credit_interval_raw = repo.get_text_setting("credit_auto_collect_interval_hours")
    try:
        credit_interval = int(credit_interval_raw) if credit_interval_raw else 24
    except ValueError:
        credit_interval = 24
    return RuntimeOptions(
        poll_interval_minutes=poll,
        scope_mode=scope,
        scope_group_id=group_id,
        scope_upns=upns,
        language=language,
        auto_backup_enabled=auto_backup_enabled,
        auto_backup_mode=auto_backup_mode,
        credit_auto_collect_enabled=credit_auto_collect_enabled,
        credit_auto_collect_interval_hours=max(credit_interval, 1),
    )


def _resolve_app_icon() -> QIcon | None:
    """Return the bundled application icon, preferring the multi-size .ico."""
    for name in ("app.ico", "app.png"):
        try:
            resource = resources.files("copilot_watchtower.resources").joinpath(name)
            path = Path(str(resource))
        except (ModuleNotFoundError, FileNotFoundError):
            continue
        if path.exists():
            return QIcon(str(path))
    return None


def _sync_profile_metadata(registry: ProfileRegistry, profile_id: str, repo: Repository) -> None:
    """Copy a few key settings from the per-profile DB into the registry.

    Keeps the picker UI label accurate (tenant id / display name) without
    forcing it to open every database.
    """
    registry.update_metadata(
        profile_id,
        tenant_id=repo.get_text_setting("tenant_id"),
        tenant_domain=repo.get_text_setting("tenant_domain"),
        display_name=repo.get_text_setting("display_name"),
        bootstrap_complete=repo.get_text_setting("bootstrap_complete") == "1",
    )


def _refresh_tenant_metadata(repo: Repository) -> None:
    """Best-effort organization metadata refresh for profile labels."""
    if repo.get_text_setting("tenant_domain"):
        return
    tenant_id = repo.get_text_setting("tenant_id")
    client_id = repo.get_text_setting("client_id")
    secret_blob = repo.get_secret("client_secret")
    if not tenant_id or not client_id or secret_blob is None:
        return
    try:
        provider = AppOnlyTokenProvider(tenant_id, client_id, unprotect(secret_blob))
        graph = GraphClient(provider, timeout=15.0)
        try:
            org = graph.organization_summary()
        finally:
            graph.close()
    except Exception:
        log.exception("Failed to refresh tenant metadata")
        return
    if org.get("domain"):
        repo.set_text_setting("tenant_domain", str(org["domain"]))
    if org.get("display_name"):
        repo.set_text_setting("tenant_display_name", str(org["display_name"]))


def _refresh_all_profile_metadata(registry: ProfileRegistry) -> None:
    """Best-effort metadata refresh before the profile picker is shown."""
    for profile in registry.profiles:
        db_path = registry.profile_db_path(profile.id)
        if not db_path.exists():
            continue
        try:
            initialize(db_path)
            repo = Repository(db_path)
            _refresh_tenant_metadata(repo)
            _sync_profile_metadata(registry, profile.id, repo)
        except Exception:
            log.exception("Failed to refresh profile metadata for %s", profile.id)


def _repair_dataverse_attribution_once(repo: Repository) -> None:
    """One-time backfill: fix Dataverse turns mis-attributed to 'unknown'.

    Older collections stored every Dataverse turn as a user prompt owned by
    ``dataverse:unknown`` because the activity role is an integer enum the
    parser did not decode. Re-attribute the existing rows once per profile,
    guarded by a settings flag so it never runs again after it succeeds.
    """
    flag = "dataverse_attribution_repaired_v1"
    try:
        if repo.get_text_setting(flag) == "1":
            return
        from .services.dataverse import repair_dataverse_attribution

        repair_dataverse_attribution(repo)
        repo.set_text_setting(flag, "1")
    except Exception:
        log.exception("Dataverse 귀속 보정 중 오류가 발생했습니다.")


def _purge_entra_audit_noise_once(repo: Repository) -> None:
    """One-time cleanup: drop directory-sync noise from earlier audit pulls.

    Earlier collections ingested Azure AD Cloud Sync ``ProvisioningManagement``
    events (often thousands) that bury the security/agent-relevant audit signal
    and are unrelated to Copilot. The collector now filters these at ingest;
    this removes the existing backlog once per profile, guarded by a flag.
    """
    flag = "entra_audit_noise_purged_v1"
    try:
        if repo.get_text_setting(flag) == "1":
            return
        from .services.audit_query import NOISE_AUDIT_CATEGORIES

        removed = repo.purge_audit_events_by_category("entra_audit", NOISE_AUDIT_CATEGORIES)
        if removed:
            log.info("Purged %d directory-sync audit events (one-time).", removed)
        repo.set_text_setting(flag, "1")
    except Exception:
        log.exception("Entra audit 노이즈 정리 중 오류가 발생했습니다.")


def _renamespace_thread_ids_once(repo: Repository) -> None:
    """One-time: regenerate conversation-thread IDs with per-source namespacing.

    Thread IDs used to be source-agnostic, so the same Teams conversation
    collected via both the Graph API and an eDiscovery export produced an
    identical ID. Upserting the eDiscovery thread then overwrote the API
    thread's ``source_type``, making those conversations vanish from the API
    conversation view. IDs now include ``source_type``; recompute every user's
    threads once so existing rows are rebuilt with non-colliding IDs (which
    also restores any API threads that were previously flipped to eDiscovery).
    """
    flag = "thread_ids_source_namespaced_v1"
    try:
        if repo.get_text_setting(flag) == "1":
            return
        from .services.threading_service import recompute_threads_for_all_users

        for source in ("api", "ediscovery", "dataverse"):
            recompute_threads_for_all_users(repo, source_type=source)
        repo.set_text_setting(flag, "1")
        log.info("Re-namespaced conversation-thread IDs by source (one-time).")
    except Exception:
        log.exception("Thread ID re-namespacing migration failed.")


def _cleanup_abandoned_onboarding_app(wizard: OnboardingWizard) -> None:
    """Best-effort cleanup when onboarding created an app but was cancelled."""
    registered = wizard.registered_app_or_none()
    token = wizard.bootstrap_token_or_none()
    tenant_id = wizard.bootstrap_tenant_id_or_none()
    if registered is None or not token or not tenant_id:
        return
    try:
        with AppRegistrar(token, tenant_id) as registrar:
            registrar.delete_application(registered.object_id)
        log.info(
            "Deleted abandoned onboarding app object_id=%s app_id=%s",
            registered.object_id,
            registered.app_id,
        )
    except Exception:
        log.exception(
            "Failed to delete abandoned onboarding app object_id=%s app_id=%s",
            registered.object_id,
            registered.app_id,
        )


def _pick_or_create_profile(
    registry: ProfileRegistry, app: QApplication
) -> tuple[Profile | None, bool]:
    """Decide which profile to run for this iteration of the main loop.

    Returns ``(profile, is_new)``. ``profile`` is None if the user
    cancelled the picker. ``is_new`` is True when the caller should
    drive the onboarding wizard for a freshly-created profile.
    """
    # Brand-new install: no profiles yet — silently create one and
    # send the user into onboarding.
    if not registry.profiles:
        profile = registry.add("기본 프로필")
        return profile, True

    # Exactly one profile — no need to interrupt the user with a
    # picker. Just use it (and create one on the fly if onboarding
    # was abandoned previously and the slot is empty).
    if len(registry) == 1:
        profile = registry.profiles[0]
        registry.set_active(profile.id)
        return profile, not profile.bootstrap_complete

    # Multiple profiles — enter the most-recently-active one directly. Profile
    # switching / adding / removing is handled in-app by the web Settings page
    # (profiles_list / profile_switch / profile_add / profile_remove), so we no
    # longer interrupt startup with a native picker dialog.
    active = registry.get(registry.active_profile_id) if registry.active_profile_id else None
    profile = active or registry.profiles[0]
    registry.set_active(profile.id)
    return profile, not profile.bootstrap_complete


def _wants_web_shell() -> bool:
    # The web shell is the only supported UI. Retained as a helper for
    # external callers and tests.
    return True


def run() -> int:
    # The main shell embeds Chromium via QWebEngineView. Inside an MSIX
    # AppContainer the Chromium *sandbox* subprocess cannot initialise and
    # the WebEngine process crashes the instant it spawns — which Windows
    # surfaces as the generic "go to advanced options ... Repair" dialog.
    # Disabling the sandbox before QtWebEngine initialises is the standard
    # fix for embedded WebEngine apps and is safe for a packaged desktop
    # tool. ``setdefault`` lets an operator override it if they ever need
    # the sandbox back.
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")

    paths_shell = AppPaths.resolve()
    configure_logging(paths_shell, verbose="--verbose" in sys.argv)
    _install_crash_handlers()
    log.info("Starting %s (shell=web)", __app_name__)

    # Multi-profile registry. ``migrate_legacy_db`` is a no-op on
    # second and subsequent runs.
    registry = ProfileRegistry.load(paths_shell.root)
    if registry.migrate_legacy_db():
        log.info("Legacy single-tenant store.db migrated to a profile.")
    _refresh_all_profile_metadata(registry)

    app = QApplication(sys.argv)
    app.setApplicationName(__app_name__)
    app.setOrganizationName(__app_name__)

    # Localize the bootstrap dialogs (profile picker / onboarding) before any
    # profile is selected, based on the OS UI language. Once a profile is
    # chosen, _load_options() applies that profile's saved language instead.
    set_active_language(_detect_system_language())

    app_icon = _resolve_app_icon()
    if app_icon is not None:
        app.setWindowIcon(app_icon)

    # Outer loop — each iteration is a "session" for one profile. The
    # main shell can request a switch (e.g. via the profile button)
    # and we loop back to the picker. Returning from the shell
    # without a switch request means the user closed the app.
    while True:
        profile, needs_onboarding = _pick_or_create_profile(registry, app)
        if profile is None:
            log.info("Profile selection cancelled. Exiting.")
            return 0

        paths = paths_shell.with_profile(profile.id, registry.profile_db_path(profile.id))
        initialize(paths.db_path)
        repo = Repository(paths.db_path)
        _repair_dataverse_attribution_once(repo)
        _purge_entra_audit_noise_once(repo)
        _renamespace_thread_ids_once(repo)
        options = _load_options(repo)
        QLocale.setDefault(QLocale(options.language.replace("_", "-")))
        set_active_language(options.language)
        registry.touch(profile.id)

        if needs_onboarding or repo.get_text_setting("bootstrap_complete") != "1":
            wizard = OnboardingWizard(repo)
            wizard.show()
            rc = app.exec()
            if repo.get_text_setting("bootstrap_complete") != "1":
                _cleanup_abandoned_onboarding_app(wizard)
                # User abandoned the wizard. If this was a brand-new
                # profile, drop the empty entry so it doesn't clutter
                # the picker on next launch.
                if not profile.bootstrap_complete:
                    registry.remove(profile.id, delete_data=True)
                return rc
            _sync_profile_metadata(registry, profile.id, repo)
            options = _load_options(repo)

        _refresh_tenant_metadata(repo)
        _sync_profile_metadata(registry, profile.id, repo)

        main = WebShellWindow(repo, paths, options, registry=registry, profile_id=profile.id)
        main.show()
        rc = app.exec()

        # The main shell exposes ``requested_switch_to`` when the user
        # picks a different profile from the toolbar menu,
        # ``requested_add_profile`` when they ask for a brand-new one,
        # and ``requested_pick_again`` after the current profile was
        # destroyed via factory reset. Anything else (including normal
        # close) ends the loop.
        switch_to = getattr(main, "requested_switch_to", None)
        add_new = getattr(main, "requested_add_profile", False)
        pick_again = getattr(main, "requested_pick_again", False)
        if switch_to:
            registry.set_active(switch_to)
            continue
        if add_new:
            # Drop into the picker again with the "add" path taken by
            # the caller. We surface this by leaving active untouched
            # and forcing the picker to appear next iteration.
            new_name = getattr(main, "requested_add_name", None) or "새 테넌트"
            new_profile = registry.add(new_name)
            registry.set_active(new_profile.id)
            continue
        if pick_again:
            # The profile we were on was removed. Loop back to let
            # ``_pick_or_create_profile`` show the picker or fall
            # through to onboarding when nothing's left.
            continue
        return rc
