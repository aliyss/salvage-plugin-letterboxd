/**
 * What this plugin remembers between visits: the poster address of a film, and
 * the colour each filed poster leads with.
 *
 * A watchlist tile names its film but carries no picture, so a film's own page
 * is read once for its poster. The address is saved here, and the next visit to
 * that film asks for no page at all. The colour map is saved beside it for the
 * same reason: a picture is decoded once in its life.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isColor } from "./color";

/** A watchlist of a few hundred films is remembered; older entries fall off. */
const MAX_POSTERS = 2_000;
const MAX_COLOURS = 2_000;
/** A film is named by its page's slug. */
const SLUG = /^[a-z0-9-]{1,120}$/;
/** A filed picture is a hash and an extension. */
const STILL = /^[a-f0-9]{8,64}\.(?:jpg|jpeg|png|webp|avif|gif)$/i;

export type PosterCache = {
  /** The poster address a film's own page named, by film slug. */
  posters: Record<string, string>;
  /** The leading colour of each filed poster, by the name it is filed under. */
  colours: Record<string, string>;
};

function dataDirectory(): string {
  return process.env.SALVAGE_PLUGIN_DATA ?? ".";
}

function cachePath(): string {
  return join(dataDirectory(), "posters.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function posterEntries(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) {
    return {};
  }
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] =>
      SLUG.test(entry[0]) &&
      typeof entry[1] === "string" &&
      /^https:\/\/[^\s]{1,400}$/.test(entry[1]),
  );
  return Object.fromEntries(entries.slice(-MAX_POSTERS));
}

function colourEntries(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) {
    return {};
  }
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] =>
      STILL.test(entry[0]) && typeof entry[1] === "string" && isColor(entry[1]),
  );
  return Object.fromEntries(entries.slice(-MAX_COLOURS));
}

/** The cache saved here, or an empty one when there is none to read. */
export async function loadCache(): Promise<PosterCache> {
  try {
    const raw: unknown = JSON.parse(await readFile(cachePath(), "utf8"));
    const body = isRecord(raw) ? raw : {};
    return {
      posters: posterEntries(body.posters),
      colours: colourEntries(body.colours),
    };
  } catch {
    return { posters: {}, colours: {} };
  }
}

/** Writes the cache beside the plugin's own pictures, whole or not at all. */
export async function saveCache(cache: PosterCache): Promise<void> {
  const path = cachePath();
  const part = `${path}.part`;
  try {
    await mkdir(dataDirectory(), { recursive: true });
    await writeFile(part, `${JSON.stringify(cache, null, 2)}\n`);
    await rename(part, path);
  } catch {
    // A cache that cannot be written costs a request later, never the answer.
  }
}
