// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { PageContainer } from "@/components";

import { AiAccessClient } from "./AiAccess.client";

/** The existing Admin shell gates the page; the API independently gates every read/write. */
export default function AiAccessPage() {
  return (
    <PageContainer maxWidth="2xl">
      <p className="max-w-prose text-muted-foreground">
        Permissions you approve here apply to this node’s AI.
      </p>
      <AiAccessClient />
    </PageContainer>
  );
}
