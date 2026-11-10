import { StyleError, parseStyleJson, resolveStyleExtends, suggest } from "@pixelworlds/style";

/**
 * The viewer's style packs (D-075): every pack in worlds/_styles/, read as
 * text only when a world needs it and parsed here, so a broken pack fails
 * only the worlds that use it (and the packs that extend it), with its file,
 * line and column in the HUD. A pack's `extends` is merged in here, so the
 * `?style=` override can be handed to the view whole.
 */

const DIR = "../../../worlds/_styles/";

/** A style resolver over pack files: path (`<dir><id>/style.json`) → its text, loaded on demand. */
export function styleLoader(files: Record<string, () => Promise<string>>, dir = DIR): (id: string) => Promise<object> {
  const ids = Object.keys(files).map((path) => path.slice(dir.length, -"/style.json".length));
  const read = async (id: string): Promise<unknown> => {
    const file = files[`${dir}${id}/style.json`];
    if (!file) throw new StyleError(`no style pack "${id}"${suggest(id, ids)}; there are ${ids.join(", ")} (worlds/_styles/)`, { pack: id });
    return parseStyleJson(await file(), `worlds/_styles/${id}/style.json`);
  };
  return async (id) => (await resolveStyleExtends(await read(id), read)) as object;
}

/** A pack by id, with its `extends` merged in: the viewer's style resolver. */
export const stylePack = styleLoader(import.meta.glob<string>("../../../worlds/_styles/*/style.json", { query: "?raw", import: "default" }));
