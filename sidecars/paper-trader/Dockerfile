# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# poly-paper-sidecar — Python sidecar wrapping agent-next/polymarket-paper-trader
# (MIT) behind an HTTP API. The TS PaperAdapter speaks to it over pod-loopback.
#
# Source is vendored under vendor/pm_trader/ (see vendor/pm_trader/PROVENANCE.md).
# UPSTREAM_PAPER_TRADER_SHA below is metadata-only — surfaced on /version as
# upstreamPaperTraderSha — and must be kept in lockstep with PROVENANCE.md's
# "Pinned SHA". Bumping the vendored upstream: see vendor/pm_trader/PROVENANCE.md.

FROM python:3.12-slim AS base

WORKDIR /app

ARG UPSTREAM_PAPER_TRADER_SHA=8a0a3ee265cfd375c172626b0c63be72c07beaee
ENV UPSTREAM_PAPER_TRADER_SHA=${UPSTREAM_PAPER_TRADER_SHA}
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

# Vendored pm_trader's dependency tree (notably mcp>=1.0 → starlette) overlaps
# with fastapi's starlette pin. Running pip in TWO resolution passes lets pm_trader
# bump starlette to a version incompatible with fastapi<0.116. ONE resolution pass
# lets the solver pick a starlette that satisfies both pins. Do not split.
COPY vendor/pm_trader/pyproject.toml /app/vendor/pm_trader/pyproject.toml
COPY vendor/pm_trader/LICENSE /app/vendor/pm_trader/LICENSE
COPY vendor/pm_trader/pm_trader /app/vendor/pm_trader/pm_trader
RUN pip install --no-cache-dir \
  "fastapi>=0.115,<0.116" \
  "uvicorn[standard]>=0.32,<0.33" \
  "pydantic>=2.9,<3" \
  /app/vendor/pm_trader

COPY server.py /app/server.py

# Default writable data dir under /tmp (compatible with readOnlyRootFilesystem).
ENV PM_TRADER_DATA_DIR=/tmp/pm_trader
ENV PM_TRADER_ACCOUNT=cogni-paper
ENV PM_TRADER_STARTING_BALANCE_USDC=1000000
ENV PAPER_CHECK_ORDERS_INTERVAL_SECONDS=30
ENV PINO_LOG_LEVEL=info

EXPOSE 9100

CMD ["uvicorn", "server:app", "--host", "127.0.0.1", "--port", "9100"]

# ---- test stage: runs pytest against server.py under a stubbed PolymarketClient
# (sidecar smoke) AND against the vendored Engine's maker-fill branch (bug.5005).
# The CI workflow targets this stage with --target=test as a build-blocker.
FROM base AS test

RUN pip install --no-cache-dir "pytest>=8" "httpx>=0.27"

COPY tests /app/tests
# Vendor's `__init__.py` + `conftest.py` (tmp_data_dir fixture) + the maker-fill
# test file. Upstream's other tests (e2e_live, mcp_server, cli, etc.) require
# network / extras we don't carry — not run in CI.
COPY vendor/pm_trader/tests/__init__.py /app/vendor/pm_trader/tests/__init__.py
COPY vendor/pm_trader/tests/conftest.py /app/vendor/pm_trader/tests/conftest.py
COPY vendor/pm_trader/tests/test_check_orders_maker_fill.py /app/vendor/pm_trader/tests/test_check_orders_maker_fill.py

# Test env mirrors prod env shape; data dir under /tmp/test to avoid clobbering.
ENV PM_TRADER_DATA_DIR=/tmp/pm_trader-test
ENV PAPER_CHECK_ORDERS_INTERVAL_SECONDS=0.1

# Two pytest invocations on purpose: the sidecar smoke installs a stub for
# `pm_trader.engine` via `sys.modules` at import time, which would poison the
# subsequent real-Engine maker-fill tests if they shared a process. Separate
# processes = clean import state for each suite.
RUN pytest -q /app/tests \
  && pytest -q /app/vendor/pm_trader/tests/test_check_orders_maker_fill.py
