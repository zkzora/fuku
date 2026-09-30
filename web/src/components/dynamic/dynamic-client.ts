"use client";

import { createDynamicClient } from "@dynamic-labs-sdk/client";
import { addEvmExtension } from "@dynamic-labs-sdk/evm";

/**
 * Module-level singleton (never per render). Only imported from components loaded with
 * `next/dynamic({ ssr: false })`, because the SDK needs `window` and browser storage.
 */
export const dynamicClient = createDynamicClient({
  environmentId: process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID ?? "",
  metadata: {
    name: "Fuku Protocol",
    // The property is `universalLink`, not `url`.
    universalLink: window.location.origin,
  },
});

// Register extensions immediately after createDynamicClient(). The default EVM extension covers
// embedded (WaaS) wallets and external wallet discovery.
addEvmExtension();
