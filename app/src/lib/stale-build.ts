const RELOADED_FROM = "openbot:stale-build-reloaded-from";

/** The path of this page's entry script, which carries the build's hash. */
export function entryPath(doc: Pick<Document, "querySelector">): string | null {
  const src = doc
    .querySelector('script[type="module"][src*="/assets/"]')
    ?.getAttribute("src");
  if (!src) return null;
  return new URL(src, "http://openbot.invalid").pathname;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * Whether a chunk that failed to load means this tab is on an old build, and should reload.
 *
 * Asks the server rather than assuming, because a dropped connection fails the same way and a reload would then lose
 * what the person was typing for nothing. At most once per build: if the reload comes back on the same entry (a cache
 * in the way), it does not try again.
 */
export async function shouldReloadForNewBuild(
  entry: string | null,
  storage: Storage,
  read: (url: string, init: RequestInit) => Promise<Response>,
): Promise<boolean> {
  if (!entry) return false;
  try {
    if (storage.getItem(RELOADED_FROM) === entry) return false;
    const response = await read("/", { cache: "no-store" });
    if (!response.ok) return false;
    const page = await response.text();
    if (!page.includes('type="module"') || page.includes(entry)) return false;
    storage.setItem(RELOADED_FROM, entry);
    return true;
  } catch {
    return false;
  }
}

/** Reloads a tab left open across a deploy when it next needs a chunk the new build no longer has. */
export function reloadOnStaleBuild() {
  const entry = entryPath(document);
  let checking = false;
  window.addEventListener("vite:preloadError", () => {
    if (checking) return;
    checking = true;
    void (async () => {
      let storage: Storage;
      try {
        storage = window.sessionStorage;
      } catch {
        checking = false;
        return;
      }
      const reload = await shouldReloadForNewBuild(entry, storage, (url, init) =>
        fetch(url, init),
      );
      checking = false;
      if (reload) window.location.reload();
    })();
  });
}
