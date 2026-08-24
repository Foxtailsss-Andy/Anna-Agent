from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx


class HarnessV2BridgeError(RuntimeError):
    def __init__(self, code: str, *, status_code: int = 503, payload: Any = None) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.payload = payload


@dataclass(frozen=True)
class HarnessV2BridgeResponse:
    payload: Any
    status_code: int


@dataclass(frozen=True)
class HarnessV2Bridge:
    origin: str
    timeout_seconds: float = 30.0
    transport: httpx.BaseTransport | None = None

    @classmethod
    def from_env(cls) -> HarnessV2Bridge | None:
        origin = os.environ.get("ANNA_HARNESS_V2_BRIDGE_ORIGIN", "").strip()
        if not origin:
            return None
        parsed = httpx.URL(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.host:
            raise ValueError("ANNA_HARNESS_V2_BRIDGE_ORIGIN must be an absolute HTTP(S) URL")
        return cls(origin=origin.rstrip("/"))

    def get_capabilities(self) -> dict[str, Any]:
        response = self._request("GET", "/capabilities")
        if not isinstance(response.payload, dict):
            raise HarnessV2BridgeError("invalid_capabilities_response", status_code=502)
        return response.payload

    def start_run(self, surface_id: str, payload: dict[str, Any]) -> HarnessV2BridgeResponse:
        response = self._request(
            "POST",
            f"/v2/surfaces/{surface_id}/runs",
            json=payload,
        )
        if not isinstance(response.payload, dict):
            raise HarnessV2BridgeError("invalid_start_response", status_code=502)
        return response

    def resume_run(
        self,
        surface_id: str,
        run_id: str,
        payload: dict[str, Any],
    ) -> HarnessV2BridgeResponse:
        response = self._request(
            "POST",
            f"/v2/surfaces/{surface_id}/runs/{run_id}/resume",
            json=payload,
        )
        if not isinstance(response.payload, dict):
            raise HarnessV2BridgeError("invalid_resume_response", status_code=502)
        return response

    def read_events(
        self,
        run_id: str,
        *,
        workspace_id: str,
        channel_id: str,
        from_seq: int,
    ) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"/v2/runs/{run_id}/events",
            params={
                "workspace_id": workspace_id,
                "channel_id": channel_id,
                "from_seq": str(from_seq),
            },
        )
        if not isinstance(response.payload, dict):
            raise HarnessV2BridgeError("invalid_events_response", status_code=502)
        return response.payload

    def list_create_runs(self, *, workspace_id: str, channel_id: str) -> dict[str, Any]:
        response = self._request(
            "GET",
            "/v2/create/runs",
            params={"workspace_id": workspace_id, "channel_id": channel_id},
        )
        if not isinstance(response.payload, dict):
            raise HarnessV2BridgeError("invalid_create_runs_response", status_code=502)
        return response.payload

    def _request(self, method: str, path: str, **kwargs: Any) -> HarnessV2BridgeResponse:
        try:
            with httpx.Client(timeout=self.timeout_seconds, transport=self.transport) as client:
                response = client.request(
                    method,
                    urljoin(self.origin + "/", path.lstrip("/")),
                    **kwargs,
                )
        except httpx.HTTPError as error:
            raise HarnessV2BridgeError("v2_bridge_unavailable") from error

        try:
            payload = response.json()
        except ValueError as error:
            raise HarnessV2BridgeError("invalid_bridge_response", status_code=502) from error
        if response.is_error:
            raise HarnessV2BridgeError(
                "v2_bridge_rejected_request",
                status_code=response.status_code,
                payload=payload,
            )
        return HarnessV2BridgeResponse(payload=payload, status_code=response.status_code)
