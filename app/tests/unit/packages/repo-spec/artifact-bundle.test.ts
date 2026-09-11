// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  buildNodeArtifactBundle,
  extractNodeArtifactBuilds,
  resolveNodeArtifactBundle,
} from "@cogni/repo-spec";
import { buildTestRepoSpec, TEST_NODE_IDS } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const APP_IMAGE = `ghcr.io/example/node@sha256:${"1".repeat(64)}`;
const WORKER_IMAGE = `ghcr.io/example/node-worker@sha256:${"2".repeat(64)}`;

function spec() {
  return buildTestRepoSpec({
    deployment: {
      services: [
        {
          name: "app",
          artifact: { name: "app" },
          port: 3200,
          visibility: "public",
          resources: { cpu_units: 1, memory_mi: 2048, storage_mi: 4096 },
        },
        {
          name: "worker",
          artifact: {
            name: "worker",
            dockerfile: "services/worker/Dockerfile",
          },
          port: 9100,
          visibility: "private",
          resources: { cpu_units: 0.5, memory_mi: 1024, storage_mi: 2048 },
        },
      ],
    },
  });
}

describe("node artifact bundle", () => {
  it("extracts each declared artifact once and marks the ingress artifact", () => {
    expect(extractNodeArtifactBuilds(spec())).toEqual([
      {
        artifact: "app",
        context: ".",
        dockerfile: "Dockerfile",
        public: true,
      },
      {
        artifact: "worker",
        context: ".",
        dockerfile: "services/worker/Dockerfile",
        public: false,
      },
    ]);
  });

  it("builds and resolves a complete immutable source-bound bundle", () => {
    const declaration = spec();
    const bundle = buildNodeArtifactBundle({
      spec: declaration,
      sourceSha: SHA,
      repository: "example/node",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: APP_IMAGE },
        { artifact: "worker", sourceSha: SHA, image: WORKER_IMAGE },
      ],
    });
    expect(bundle).toMatchObject({
      source: { repository: "example/node", sha: SHA },
      artifacts: [
        { name: "app", image: APP_IMAGE },
        { name: "worker", image: WORKER_IMAGE },
      ],
      services: [
        { name: "app", artifact: "app" },
        { name: "worker", artifact: "worker" },
      ],
    });
    const resolved = resolveNodeArtifactBundle(declaration, bundle, {
        sourceSha: SHA,
        repository: "example/node",
      });
    expect(resolved).toMatchObject({
      nodeId: TEST_NODE_IDS.default,
      source: { repository: "example/node", sha: SHA },
    });
    expect(resolved.services[0]?.service.secretRefs).toEqual([]);
  });

  it.each([
    {
      name: "missing artifact",
      artifacts: [{ artifact: "app", sourceSha: SHA, image: APP_IMAGE }],
      message: /Missing artifact/,
    },
    {
      name: "mixed source SHA",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: APP_IMAGE },
        {
          artifact: "worker",
          sourceSha: "b".repeat(40),
          image: WORKER_IMAGE,
        },
      ],
      message: /Source SHA mismatch/,
    },
    {
      name: "mutable image",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: "ghcr.io/example/node:latest" },
        { artifact: "worker", sourceSha: SHA, image: WORKER_IMAGE },
      ],
      message: /Invalid bundle/,
    },
  ])("fails atomically on $name", ({ artifacts, message }) => {
    expect(() =>
      buildNodeArtifactBundle({
        spec: spec(),
        sourceSha: SHA,
        repository: "example/node",
        artifacts,
      })
    ).toThrow(message);
  });

  it.each([
    {
      expected: { sourceSha: "b".repeat(40), repository: "example/node" },
      message: /Source SHA mismatch/,
    },
    {
      expected: { sourceSha: SHA, repository: "example/other" },
      message: /Repository mismatch/,
    },
  ])("rejects the wrong flight identity", ({ expected, message }) => {
    const declaration = spec();
    const bundle = buildNodeArtifactBundle({
      spec: declaration,
      sourceSha: SHA,
      repository: "example/node",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: APP_IMAGE },
        { artifact: "worker", sourceSha: SHA, image: WORKER_IMAGE },
      ],
    });
    expect(() =>
      resolveNodeArtifactBundle(declaration, bundle, expected)
    ).toThrow(message);
  });

  it("canonicalizes GitHub repository identity case", () => {
    const declaration = spec();
    const bundle = buildNodeArtifactBundle({
      spec: declaration,
      sourceSha: SHA,
      repository: "Example/Node",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: APP_IMAGE },
        { artifact: "worker", sourceSha: SHA, image: WORKER_IMAGE },
      ],
    });
    expect(bundle.source.repository).toBe("example/node");
    expect(() =>
      resolveNodeArtifactBundle(declaration, bundle, {
        sourceSha: SHA,
        repository: "EXAMPLE/NODE",
      })
    ).not.toThrow();
  });
});
