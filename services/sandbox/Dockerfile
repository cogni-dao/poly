# Poly's `sandbox` repo-spec artifact (story.0090). The standard node-template sandbox image, unchanged:
# the repo-spec schema and node CI require every declared service to name a buildable artifact, so this is
# the whole file. Nothing is copied from node-template's services/sandbox (hub `node-sandbox-design`:
# a node that needs more tools starts FROM the standard digest; this node needs none).
# The running worker pins the same digest in .cogni/workloads/sandbox.yaml; bump both together.
FROM ghcr.io/cogni-dao/node-template-sandbox@sha256:2be482af45e49673b7fc42973cf8408d7497750593ef5153d4919092a1b4834e
