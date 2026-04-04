import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/index";

const baseUrl =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}`
    : "http://localhost:7705";

export const api = treaty<App>(baseUrl);
