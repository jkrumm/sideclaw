import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/index";

const baseUrl =
  typeof window !== "undefined"
    ? `http://${window.location.host}`
    : "http://localhost:7705";

export const api = treaty<App>(baseUrl);
