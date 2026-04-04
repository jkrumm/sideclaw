import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { existsSync, readFileSync } from "fs";
import { reposRoutes } from "./routes/repos";
import { queueRoutes } from "./routes/queue";
import { notesRoutes } from "./routes/notes";
import { eventsRoutes } from "./routes/events";
import { markdownRoutes } from "./routes/markdown";
import { completedRoutes } from "./routes/completed";
import { usageRoutes } from "./routes/usage";
import { githubRoutes } from "./routes/github";
import { diagramsRoutes } from "./routes/diagrams";
import { actionsRoutes } from "./routes/actions";
import { kioskRoute } from "./routes/kiosk";

const isDev = !existsSync("dist/index.html");
const indexHtml = isDev ? null : readFileSync("dist/index.html", "utf-8");
const BUILD_ID = crypto.randomUUID();

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .get("/api/build-id", () => ({ buildId: BUILD_ID }))
  .use(reposRoutes)
  .use(queueRoutes)
  .use(notesRoutes)
  .use(eventsRoutes)
  .use(markdownRoutes)
  .use(completedRoutes)
  .use(usageRoutes)
  .use(githubRoutes)
  .use(diagramsRoutes)
  .use(actionsRoutes)
  .use(kioskRoute);

if (!isDev) {
  app
    .use(staticPlugin({ assets: "dist/assets", prefix: "/assets" }))
    .get("*", ({ set }) => {
      set.headers["content-type"] = "text/html; charset=utf-8";
      set.headers["cache-control"] = "no-cache";
      return indexHtml;
    });
}

const PORT = parseInt(process.env.PORT ?? "7705");
app.listen(PORT);

console.log(
  isDev
    ? `sideclaw API running on :${PORT} (dev — frontend at :7705 via Vite)`
    : `sideclaw running on :${PORT}`,
);

export type App = typeof app;
