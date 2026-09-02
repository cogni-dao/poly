// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { extractNodeServices, parseRepoSpec } from "@cogni/repo-spec";
import { buildTestRepoSpec } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";

const APP = {
  name: "app",
  artifact: { name: "app" },
  port: 3200,
  visibility: "public",
  resources: { cpu_units: 1, memory_mi: 2048, storage_mi: 4096 },
} as const;

describe("node deployment repo-spec", () => {
  it("preserves the existing one-image node-template when omitted", () => {
    expect(extractNodeServices(buildTestRepoSpec())).toEqual([
      {
        name: "app",
        artifact: {
          name: "app",
          context: ".",
          dockerfile: "Dockerfile",
          target: "runner",
        },
        port: 3200,
        visibility: "public",
        bindings: {},
        secretRefs: [],
        bindHost: "0.0.0.0",
        internalUrl: "http://app:3200",
        resources: { cpuUnits: 2, memoryMi: 2048, storageMi: 4096 },
      },
    ]);
  });

  it("declares a public app, private sibling, and Git-owned binding", () => {
    const services = extractNodeServices(
      buildTestRepoSpec({
        deployment: {
          services: [
            { ...APP, bindings: { WORKER_URL: "worker" } },
            {
              name: "worker",
              artifact: {
                name: "worker",
                context: "services/worker",
                dockerfile: "services/worker/Dockerfile",
              },
              port: 9100,
              visibility: "private",
              resources: {
                cpu_units: 0.5,
                memory_mi: 1024,
                storage_mi: 2048,
              },
            },
          ],
        },
      })
    );

    expect(services[0]?.bindings).toEqual({ WORKER_URL: "worker" });
    expect(services[1]).toMatchObject({
      name: "worker",
      bindHost: "0.0.0.0",
      internalUrl: "http://worker:9100",
      visibility: "private",
    });
  });

  it("allows two services to reuse identical build instructions", () => {
    const services = extractNodeServices(
      buildTestRepoSpec({
        deployment: {
          services: [
            APP,
            {
              name: "worker",
              artifact: { name: "app" },
              port: 9100,
              visibility: "private",
              resources: {
                cpu_units: 0.5,
                memory_mi: 1024,
                storage_mi: 2048,
              },
            },
          ],
        },
      })
    );
    expect(services.map((service) => service.artifact.name)).toEqual([
      "app",
      "app",
    ]);
  });

  it("carries bounded value-free secret requirements", () => {
    const services = extractNodeServices(
      buildTestRepoSpec({
        deployment: {
          services: [
            { ...APP, secret_refs: [{ key: "APP_TOKEN" }] },
            {
              name: "worker",
              artifact: { name: "worker" },
              port: 9100,
              visibility: "private",
              resources: {
                cpu_units: 0.5,
                memory_mi: 1024,
                storage_mi: 2048,
              },
            },
          ],
        },
      })
    );
    expect(services[0]?.secretRefs).toEqual([{ key: "APP_TOKEN" }]);
  });

  it.each([
    {
      name: "missing binding target",
      services: [{ ...APP, bindings: { WORKER_URL: "worker" } }],
      message: /binding target is not declared/,
    },
    {
      name: "loopback bind",
      services: [{ ...APP, bind_host: "127.0.0.1" }],
      message: /Invalid repo-spec structure/,
    },
    {
      name: "two public services",
      services: [APP, { ...APP, name: "other" }],
      message: /exactly one public service/,
    },
    {
      name: "secret value in Git",
      services: [
        { ...APP, secret_refs: [{ key: "APP_TOKEN", value: "forbidden" }] },
      ],
      message: /Invalid repo-spec structure/,
    },
    {
      name: "binding and secret collision",
      services: [
        {
          ...APP,
          bindings: { APP_TOKEN: "worker" },
          secret_refs: [{ key: "APP_TOKEN" }],
        },
        { ...APP, name: "worker", visibility: "private" },
      ],
      message: /cannot be both a sibling binding and a secret ref/,
    },
  ])("rejects $name", ({ services, message }) => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: { services },
      })
    ).toThrow(message);
  });

  it("rejects implicit sizing for an explicitly declared service", () => {
    const { resources: _resources, ...appWithoutResources } = APP;
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: { services: [appWithoutResources] },
      })
    ).toThrow(/Invalid repo-spec structure/);
  });

  it("rejects partial explicit sizing", () => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [{ ...APP, resources: { cpu_units: 2 } }],
        },
      })
    ).toThrow(/Invalid repo-spec structure/);
  });

  it("rejects persistent-state fields structurally, not service names", () => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [{ ...APP, persistent_volume: { size_mi: 1024 } }],
        },
      })
    ).toThrow(/Invalid repo-spec structure/);

    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [APP, { ...APP, name: "redis", visibility: "private" }],
        },
      })
    ).not.toThrow();
  });
});
