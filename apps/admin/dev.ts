import { serve, file } from "bun";
import { join } from "path";
import index from "./public/index.html";

const API_TARGET = process.env.API_TARGET || "http://localhost:2529";

const server = serve({
  port: 3000,
  routes: {
    // API proxy - handle before SPA catch-all
    "/api/*": async (req) => {
      const url = new URL(req.url);
      const apiPath = url.pathname.replace(/^\/api/, "");
      const apiUrl = new URL(apiPath, API_TARGET);
      apiUrl.search = url.search;

      const headers = new Headers(req.headers);
      headers.delete("host");

      return fetch(apiUrl.toString(), {
        method: req.method,
        headers,
        body: req.body,
      });
    },
    // Serve built CSS from dist folder
    "/dist/*": async (req) => {
      const url = new URL(req.url);
      const filePath = join(import.meta.dir, url.pathname);
      const f = file(filePath);
      if (await f.exists()) {
        return new Response(f, {
          headers: { "Content-Type": "text/css" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
    // SPA - all other routes serve index.html
    "/*": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Admin UI running at http://localhost:${server.port}`);
console.log(`API proxy target: ${API_TARGET}`);
