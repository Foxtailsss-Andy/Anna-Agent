"""Managed model-less business API entry for the Harness-backed product."""

from __future__ import annotations

import uvicorn

from services.api.app.main import create_app
from services.business.mode import BusinessModeConfig


_config = BusinessModeConfig.from_env()
app = create_app(product_mode=True, business_mode_config=_config)


if __name__ == "__main__":  # pragma: no cover - exercised by uvicorn in live runs
    uvicorn.run(
        app,
        host=_config.bind_host,
        port=_config.port,
        log_level="info",
    )
