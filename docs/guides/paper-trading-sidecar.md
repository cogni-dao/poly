---
id: guide.paper-trading-sidecar
summary: Node-local contract for restoring Poly paper trading through a pod-loopback sidecar.
---

# Paper Trading Sidecar

Poly owns the paper trading sidecar source, image build, app loopback client, and
candidate proof. The operator owns only deploy-plane injection of the sidecar
container into the Poly app pod.

Node-local pieces:

- `sidecars/paper-trader`: FastAPI wrapper over the vendored
  `agent-next/polymarket-paper-trader` code.
- `.github/workflows/ci.yaml`: builds the sidecar `test` Docker stage so smoke
  tests block PRs.
- `.github/workflows/pr-build.yml`: publishes an additional build manifest target
  named `paper-trader` to `ghcr.io/<owner>/<repo>-paper-trader:sha-<head_sha>`.
- `app/src/adapters/server/paper-trading`: typed app-side client using
  `PAPER_SIDECAR_URL`, defaulting to `http://127.0.0.1:9100`.
- `app/src/shared/env/server-env.ts`: candidate/preview must run
  `PAPER_ENFORCE_MODE=paper`; live mode requires explicit
  `PAPER_LIVE_TRADING_APPROVED=true`.
- `k8s/base/paper-trader-sidecar.yaml`: node-owned base declaration for the
  sidecar container. It intentionally creates no Service or Ingress.

Operator-side requirement:

The operator deploy plane must read the node PR build manifest target
`paper-trader`, substitute its digest into `k8s/base/paper-trader-sidecar.yaml`,
and patch the Poly app Deployment to run that container in the same pod as the
Next.js app. The sidecar binds to `127.0.0.1:9100`; probes use in-container
`exec` checks so no pod-IP listener is needed. It must also set the app
container env:

```text
PAPER_SIDECAR_URL=http://127.0.0.1:9100
PAPER_ENFORCE_MODE=paper
```

for candidate and preview. Production must keep live trading disabled unless a
separate approval sets `PAPER_ENFORCE_MODE=live` and
`PAPER_LIVE_TRADING_APPROVED=true`.

Candidate proof must verify:

- app `/version` reports the PR head SHA,
- sidecar `/healthz`, `/readyz`, and `/version` succeed from inside the pod,
- `POST /place-order`, `GET /orders/{id}`, and `POST /orders/{id}/cancel`
  succeed from inside the pod,
- no public HTTP route, Kubernetes Service, or Ingress exposes port `9100`.
