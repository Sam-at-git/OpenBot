import type { Context, Env, Hono, Schema } from "hono";
import { serveStatic } from "hono/bun";

/** Asks the browser to check before reusing the page, because it names the build's hashed files. */
const INDEX_CACHE_CONTROL = "no-cache";

/**
 * The built app, on the routes left over once the API has claimed its own. Mount it last.
 *
 * A file under `/assets` that is not there is a 404, never the app's HTML: a tab left open across a deploy asks for the
 * old build's chunks, and HTML with a 200 reaches it as a module that cannot be loaded.
 */
export function mountBuiltApp<E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  root: string,
) {
  app.use(
    "/*",
    serveStatic({
      root,
      onFound: (path: string, context: Context) => {
        if (path.endsWith("/index.html"))
          context.header("Cache-Control", INDEX_CACHE_CONTROL);
      },
    }),
  );
  /*
   * A single-page app owns its routing, so a path with no file behind it is not missing: it is a
   * route the browser resolves once index.html has loaded. Without this, every deep link and every
   * refresh away from `/` is a 404, which is the classic way this deployment shape breaks.
   *
   * Written out rather than a second `serveStatic`, whose `path` option is resolved relative to the
   * working directory and silently matches nothing when handed the absolute root used above.
   *
   * `/api` is excluded so an unmatched API route still answers as one. Returning the app's HTML to
   * a fetch that expected JSON is the failure that gets read as "the API returned HTML".
   */
  app.get("*", async (context) => {
    const { path } = context.req;
    if (path.startsWith("/api") || path.startsWith("/assets/"))
      return context.notFound();
    const index = Bun.file(`${root}/index.html`);
    if (!(await index.exists())) return context.notFound();
    return new Response(index, {
      headers: {
        "cache-control": INDEX_CACHE_CONTROL,
        "content-type": "text/html; charset=utf-8",
      },
    });
  });
}
