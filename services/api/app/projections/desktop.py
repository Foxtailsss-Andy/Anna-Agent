from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..redaction import _blank_to_none


def _desktop_delivery_readiness(project_root: Path) -> dict[str, Any]:
    package_json = _read_package_json(project_root / "package.json")
    build = package_json.get("build", {}) if isinstance(package_json.get("build"), dict) else {}
    mac = build.get("mac", {}) if isinstance(build.get("mac"), dict) else {}
    directories = (
        build.get("directories", {})
        if isinstance(build.get("directories"), dict)
        else {}
    )
    output_dir = str(directories.get("output") or "release")
    product_name = str(build.get("productName") or package_json.get("name") or "Anna")
    app_path = project_root / output_dir / "mac-arm64" / f"{product_name}.app"
    resources_path = app_path / "Contents" / "Resources"
    app_asar_path = resources_path / "app.asar"
    unpacked_root = resources_path / "app.asar.unpacked"
    python_sidecar = unpacked_root / "build" / "python-runtime" / "python" / "bin" / "python3.12"
    desktop_index = unpacked_root / "dist" / "index.html"
    package_ready = (
        app_path.exists()
        and app_asar_path.exists()
        and unpacked_root.exists()
        and python_sidecar.exists()
        and desktop_index.exists()
    )
    production_signing_configured = bool(
        _blank_to_none(mac.get("identity"))
        or _blank_to_none(os.environ.get("CSC_NAME"))
        or _blank_to_none(os.environ.get("CSC_LINK"))
    )
    notarization_configured = bool(
        build.get("notarize")
        or _blank_to_none(os.environ.get("APPLE_ID"))
        or _blank_to_none(os.environ.get("APPLE_API_KEY"))
    )
    blockers: list[str] = []
    if not package_ready:
        blockers.append("desktop_package_not_built")
    if not production_signing_configured:
        blockers.append("production_signing_not_configured")
    if not notarization_configured:
        blockers.append("notarization_not_configured")
    production_ready = package_ready and not blockers
    if production_ready:
        status = "production_ready"
    elif package_ready:
        status = "development_ready"
    else:
        status = "not_built"
    return {
        "writes_external_data": False,
        "summary": {
            "status": status,
            "production_ready": production_ready,
            "blockers": blockers,
        },
        "app": {
            "name": str(package_json.get("name") or "anna"),
            "version": str(package_json.get("version") or "unknown"),
            "product_name": product_name,
            "app_id": str(build.get("appId") or "unknown"),
        },
        "package": {
            "app_path": str(app_path),
            "app_exists": app_path.exists(),
            "asar_enabled": bool(build.get("asar")),
            "app_asar_exists": app_asar_path.exists(),
            "unpacked_root_exists": unpacked_root.exists(),
            "python_sidecar_exists": python_sidecar.exists(),
            "desktop_index_exists": desktop_index.exists(),
            "size_bytes": _path_size_bytes(app_path),
        },
        "signing": {
            "status": "configured" if production_signing_configured else "not_configured",
            "production_signing_configured": production_signing_configured,
            "identity_configured": production_signing_configured,
            "development_ad_hoc_expected": not production_signing_configured,
        },
        "notarization": {
            "status": "configured" if notarization_configured else "not_configured",
            "configured": notarization_configured,
        },
        "commands": {
            "package": "npm run desktop:package",
            "smoke": "npm run desktop:smoke-asar",
        },
    }


def _read_package_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        content = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return content if isinstance(content, dict) else {}


def _path_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:
                continue
    return total
