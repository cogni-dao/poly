# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Adds the sidecar root (parent of `tests/`) to sys.path so `import server`
# resolves both locally (pytest tests/) and inside the Docker test stage
# (pytest /app/tests with /app/server.py).

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
