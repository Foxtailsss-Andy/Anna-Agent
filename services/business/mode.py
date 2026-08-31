from __future__ import annotations

import os
from dataclasses import dataclass, replace
from urllib.parse import urlparse


class BusinessModeConfigurationError(ValueError):
    """Raised when Harness-backed business mode cannot fail closed."""


@dataclass(frozen=True)
class BusinessModeConfig:
    """Explicit configuration for the managed, model-less business process.

    The business process owns identity, stores, workflows and connectors. It
    never owns model credentials or an Agent loop. The Host origin and service
    token are required together whenever product mode is enabled.
    """

    enabled: bool = False
    host_origin: str | None = None
    service_token: str | None = None
    bind_host: str = "127.0.0.1"
    port: int = 0
    request_timeout_seconds: float = 30.0
    poll_interval_seconds: float = 0.05
    wait_timeout_seconds: float = 300.0

    @classmethod
    def from_env(cls) -> "BusinessModeConfig":
        enabled = (
            _env_bool("ANNA_BUSINESS_MODE")
            or _env_bool("ANNA_PRODUCT_MODE")
            or _env_bool("ANNA_HARNESS_BUSINESS_MODE")
        )
        origin = _first_env(
            "ANNA_HARNESS_HOST_ORIGIN",
            "ANNA_HARNESS_HOST_URL",
            "ANNA_HARNESS_URL",
        )
        token = _first_env(
            "ANNA_SERVICE_TOKEN",
            "ANNA_HARNESS_SERVICE_TOKEN",
            "ANNA_HARNESS_BUSINESS_SERVICE_TOKEN",
            "ANNA_BUSINESS_SERVICE_TOKEN",
        )
        bind_host = _first_env("ANNA_BUSINESS_HOST", "ANNA_HARNESS_BUSINESS_HOST") or "127.0.0.1"
        port = _positive_int(
            _first_env("ANNA_BUSINESS_PORT", "ANNA_HARNESS_BUSINESS_PORT"), default=0
        )
        timeout = _positive_float(
            os.getenv("ANNA_HARNESS_REQUEST_TIMEOUT_SECONDS"), default=30.0
        )
        poll = _positive_float(
            os.getenv("ANNA_HARNESS_POLL_INTERVAL_SECONDS"), default=0.05
        )
        wait_timeout = _positive_float(
            os.getenv("ANNA_HARNESS_WAIT_TIMEOUT_SECONDS"), default=300.0
        )
        config = cls(
            enabled=enabled,
            host_origin=origin,
            service_token=token,
            bind_host=bind_host,
            port=port,
            request_timeout_seconds=timeout,
            poll_interval_seconds=poll,
            wait_timeout_seconds=wait_timeout,
        )
        config.validate()
        return config

    def validate(self) -> None:
        if not self.enabled:
            return
        if not self.host_origin:
            raise BusinessModeConfigurationError(
                "Harness-backed business mode requires ANNA_HARNESS_HOST_ORIGIN"
            )
        parsed = urlparse(self.host_origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise BusinessModeConfigurationError(
                "ANNA_HARNESS_HOST_ORIGIN must be an http(s) URL"
            )
        if not self.service_token:
            raise BusinessModeConfigurationError(
                "Harness-backed business mode requires ANNA_SERVICE_TOKEN"
            )
        if self.port < 0 or self.port > 65535:
            raise BusinessModeConfigurationError(
                "ANNA_BUSINESS_PORT must be between 0 and 65535"
            )

    def require_enabled(self) -> "BusinessModeConfig":
        self.validate()
        if not self.enabled:
            raise BusinessModeConfigurationError(
                "Harness-backed business mode is not enabled"
            )
        return self


def without_model_credentials(settings):
    """Return RuntimeSettings safe for the managed business process.

    The Python process may still use connector and state paths from the normal
    config, but it has no model endpoint/key/profile and therefore cannot call
    the legacy provider even if an outer environment accidentally includes one.
    """
    return replace(
        settings,
        model_endpoint=None,
        model_api_key=None,
        model_reasoning_effort=None,
        model_profiles=(),
    )


def _first_env(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value is not None and value.strip():
            return value.strip()
    return None


def _env_bool(name: str) -> bool:
    value = os.getenv(name)
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


def _positive_int(value: str | None, *, default: int) -> int:
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed >= 0 else default


def _positive_float(value: str | None, *, default: float) -> float:
    if value is None or not value.strip():
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default
