import { StyleError, parseStyleJson, suggest } from "@pixelworlds/style";

// Every style pack in the repo, by id; a world names its pack in the manifest. Read as
// text only when a world needs it and parsed here (D-075), so a broken pack fails only
// the worlds that use it, with its file, line and column. The page and the dogfight's
// server (D-114) both read them this way: bundled, not from disk.
const STYLE_FILES = import.meta.glob<string>("../../../worlds/_styles/*/style.json", { query: "?raw", import: "default" });
export const STYLE_IDS = Object.keys(STYLE_FILES).map((path) => path.split("/").at(-2)!);

export async function stylePack(id: string): Promise<object> {
  const file = STYLE_FILES[`../../../worlds/_styles/${id}/style.json`];
  if (!file) throw new StyleError(`no style pack "${id}"${suggest(id, STYLE_IDS)}; there are ${STYLE_IDS.join(", ")} (worlds/_styles/)`, { pack: id });
  return parseStyleJson(await file(), `worlds/_styles/${id}/style.json`) as object;
}
