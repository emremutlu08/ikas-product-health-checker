"use client";

import { AppBridgeHelper } from "@ikas/app-helpers";
import { useEffect } from "react";

export function IkasAppBridgeReady() {
  useEffect(() => {
    AppBridgeHelper.closeLoader();
  }, []);

  return null;
}
