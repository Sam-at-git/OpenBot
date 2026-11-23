import type { ElementHandle, Locator } from "playwright";

/** Most files one upload may put into a field. */
export const MAX_PAGE_UPLOAD_FILES = 10;

/** The Bot's to fix (another ref, fewer files), so the route answers 400 rather than 502. */
export class PageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageUploadError";
  }
}

export function pageUploadPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((path) => typeof path !== "string" || !path)
  )
    throw new PageUploadError("An upload needs at least one workspace file.");
  if (value.length > MAX_PAGE_UPLOAD_FILES)
    throw new PageUploadError(
      `One upload takes at most ${MAX_PAGE_UPLOAD_FILES} files.`,
    );
  return [...new Set(value as string[])];
}

/**
 * The file input a ref stands for.
 *
 * Most sites hide the real input and show a styled button, and a hidden input is not in the accessibility snapshot. So
 * the ref may be the input, its label, or the control beside it: the nearest enclosing element (four levels at most)
 * holding exactly one. Nothing is clicked, so this cannot press a button a rule about clicks would have refused, and
 * two inputs at the same distance are refused rather than guessed between.
 */
export async function fileInputFor(
  field: Locator,
): Promise<ElementHandle<HTMLInputElement>> {
  const handle = await field.evaluateHandle((element) => {
    const isFileInput = (node: Element | null | undefined) =>
      node?.tagName === "INPUT" && (node as HTMLInputElement).type === "file";
    if (isFileInput(element)) return element;
    const labelled = element.closest("label")?.control;
    if (isFileInput(labelled)) return labelled;
    let scope: Element | null = element;
    for (let depth = 0; scope && depth <= 4; depth += 1) {
      const found: NodeListOf<Element> =
        scope.querySelectorAll('input[type="file"]');
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
      scope = scope.parentElement;
    }
    return null;
  });
  const input = handle.asElement();
  if (!input)
    throw new PageUploadError(
      "That ref is not a file upload control, and exactly one file input could not be found beside it. Take a new snapshot and use the ref of the upload field or its button.",
    );
  return input as ElementHandle<HTMLInputElement>;
}

/** Sets the files through the browser's automation protocol, so no file dialog opens and `change` fires as usual. */
export async function uploadToField(
  field: Locator,
  paths: string[],
  acting: { timeout: number },
): Promise<void> {
  const input = await fileInputFor(field);
  if (paths.length > 1 && !(await input.evaluate((node) => node.multiple)))
    throw new PageUploadError(
      "This upload field takes one file. Upload them one at a time if the page allows it.",
    );
  await input.setInputFiles(paths, { timeout: acting.timeout });
}
