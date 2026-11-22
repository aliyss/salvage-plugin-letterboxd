/**
 * Reads a profile's watchlist and one film's page from letterboxd.com.
 *
 * Letterboxd has no public API, so what it publishes is what is read: the
 * watchlist is a grid of poster tiles on a public profile, and a film's page
 * carries a schema.org block with its name, synopsis and poster. Both are
 * server-rendered, so one request answers a whole page — the tiles' pictures
 * are the exception: they are swapped in by the site's own script, so a tile
 * often arrives with only its title and address, and a canvas card paints the
 * colour block it would otherwise leave empty.
 */

import { PluginError } from "./sdk";

const ORIGIN = "https://letterboxd.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
/** A watchlist page is around 200 KB of markup; this is room, not a target. */
const MAX_BYTES = 4_000_000;
/** How many Letterboxd pages one answer may read before it gives up. */
const MAX_PAGE_FETCHES = 4;
/** The most films a canvas may be handed in one answer. */
const MAX_ITEMS = 200;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 600;
const MAX_SLUG = 120;
const MIN_YEAR = 1870;
const MAX_YEAR = 2100;
/** A profile name: Letterboxd's own rule, and nothing that is not a name. */
const USERNAME = /^[A-Za-z0-9_-]{1,40}$/;
/** A film page: `letterboxd.com/film/the-shawshank-redemption/`. */
const FILM_PAGE = /^https?:\/\/(?:www\.)?letterboxd\.com\/film\/([a-z0-9-]{1,120})\/?/i;
/** A poster the site's script would have swapped in. */
const PILOTED_POSTER = /https:\/\/a\.ltrbxd\.com\/[^"'\s\\<>]+/;

/** One film on a watchlist, as a canvas card needs it. */
export type Film = {
  /** Its page's slug, which is what a card and a note point at. */
  id: string;
  title: string;
  year: number | null;
  url: string;
  /** The poster the markup named, when it named one. */
  poster: string | null;
};

/** One page of a watchlist, and whether another page follows it. */
export type WatchlistPage = {
  films: Film[];
  hasNext: boolean;
};

/** Which public list of a profile a canvas reads. */
export type ListSource =
  | { kind: "watchlist" }
  | { kind: "films" }
  | { kind: "list"; slug: string };

/** What a link preview needs from a film: its name, its plot and its poster. */
export type Preview = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entities Letterboxd writes into its own attributes. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** The profile name a setting holds, or null when it is not one. */
export function usernameOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().replace(/^@/, "");
  return USERNAME.test(name) ? name : null;
}

/** The film slug an entry links to, or null for any other address. */
export function filmSlugFrom(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = FILM_PAGE.exec(url.trim());
  const slug = match?.[1]?.toLowerCase() ?? null;
  return slug && slug.length <= MAX_SLUG ? slug : null;
}

/** A list page, or its first when `page` is one. */
export function listUrl(
  source: ListSource,
  username: string,
  page: number,
): string {
  const path =
    source.kind === "films"
      ? `${username}/films/`
      : source.kind === "list"
        ? `${username}/list/${source.slug}/`
        : `${username}/watchlist/`;
  return page <= 1
    ? `${ORIGIN}/${path}`
    : `${ORIGIN}/${path}page/${String(page)}/`;
}

/** The profile's watchlist, or its first page when `page` is one. */
export function watchlistUrl(username: string, page: number): string {
  return listUrl({ kind: "watchlist" }, username, page);
}

/**
 * A list's own name: the last part of `letterboxd.com/<user>/list/<name>/`, or
 * the whole address pasted from the browser. Null for anything that is not one.
 */
export function listSlugFrom(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const match =
    /letterboxd\.com\/(?:[A-Za-z0-9_-]+)\/list\/([A-Za-z0-9][A-Za-z0-9-]{0,119})\/?/i.exec(
      raw,
    );
  const slug = match?.[1] ?? (/^[A-Za-z0-9][A-Za-z0-9-]{0,119}$/.test(raw) ? raw : null);
  return slug ? slug.toLowerCase() : null;
}

/** A film's own page. */
export function filmUrl(slug: string): string {
  return `${ORIGIN}/film/${slug}/`;
}

/** One request to Letterboxd, answered as its markup. */
async function readPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en",
      "user-agent": USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!response) {
    throw new PluginError("refused", "Letterboxd could not be reached.");
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new PluginError(
      "no_data",
      "Letterboxd has no page at that address.",
    );
  }
  if (response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new PluginError(
      "refused",
      "Letterboxd refused this computer's request. Try again in a moment.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PluginError(
      "refused",
      `Letterboxd answered ${String(response.status)}.`,
    );
  }

  const raw = await new Response(response.body).text();
  if (raw.length > MAX_BYTES) {
    throw new PluginError("refused", "Letterboxd answered with too much data.");
  }
  return raw;
}

/** One attribute of a tag's markup, decoded, or null when it is not there. */
function attribute(block: string, name: string): string | null {
  const match = new RegExp(`${name}=["']([^"']*)["']`).exec(block);
  const value = match?.[1] ? decodeEntities(match[1]).trim() : "";
  return value || null;
}

/** A title as the tile names it: "Black Bag (2025)" is a name and a year. */
function nameAndYear(value: string | null): {
  title: string | null;
  year: number | null;
} {
  if (!value) {
    return { title: null, year: null };
  }
  const match = /^(.*?)\s*\((\d{4})\)\s*$/.exec(value);
  if (!match?.[1]) {
    return { title: value.slice(0, MAX_TITLE), year: null };
  }
  const year = Number(match[2]);
  return {
    title: match[1].trim().slice(0, MAX_TITLE),
    year: year >= MIN_YEAR && year <= MAX_YEAR ? year : null,
  };
}

/**
 * The films on a list page.
 *
 * Every tile is a `<li>` — a `griditem` on a watchlist or watched-films page,
 * and a `posteritem` on a list — and the film it names is in the tile's own
 * attributes. The site's script turns those into a picture later, which is why
 * a tile usually carries no poster here.
 */
export function parseWatchlist(html: string): WatchlistPage {
  const films: Film[] = [];
  const seen = new Set<string>();

  for (const block of html.split(/<li[\s>]/).slice(1)) {
    const link = attribute(block, "data-item-link");
    const slug = link
      ? filmSlugFrom(`${ORIGIN}${link}`)
      : attribute(block, "data-item-slug");
    if (!slug || seen.has(slug)) {
      continue;
    }
    const { title, year } = nameAndYear(
      attribute(block, "data-item-full-display-name") ??
        attribute(block, "data-item-name"),
    );
    // A tile is only a film when it names one; a placeholder has neither.
    if (!title) {
      continue;
    }
    seen.add(slug);
    films.push({
      id: slug,
      title,
      year,
      url: filmUrl(slug),
      poster: PILOTED_POSTER.exec(block)?.[0] ?? null,
    });
  }

  return { films, hasNext: /<a class="next" href="/.test(html) };
}

/** The JSON an answer's schema.org block carries, unwrapped from its comment. */
function schemaBlock(html: string): Record<string, unknown> | null {
  const match =
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) {
    return null;
  }
  const clean = match[1]
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, "")
    .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, "")
    .trim();
  try {
    const body: unknown = JSON.parse(clean);
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** One meta tag's content, decoded. */
function metaContent(html: string, property: string): string | null {
  const match = new RegExp(
    `<meta property="${property}" content="([^"]*)"`,
  ).exec(html);
  return match?.[1] ? decodeEntities(match[1]).trim() || null : null;
}

/**
 * What one film's page says about it. The schema.org block is the whole of it —
 * name, synopsis and poster — and its own meta tags are the fallback for a page
 * that answers without one.
 */
export function parseFilm(html: string): Preview {
  const block = schemaBlock(html);
  const name = block && typeof block.name === "string" ? block.name : null;
  const description =
    block && typeof block.description === "string" ? block.description : null;
  const image = block && typeof block.image === "string" ? block.image : null;

  return {
    title: (name ?? metaContent(html, "og:title"))?.slice(0, MAX_TITLE) ?? null,
    description:
      (description ?? metaContent(html, "og:description"))?.slice(
        0,
        MAX_DESCRIPTION,
      ) ?? null,
    imageUrl: image ?? metaContent(html, "og:image"),
  };
}

/**
 * The page of a watchlist a card page needs.
 *
 * Letterboxd pages a watchlist by its own tiles, and how many a page holds is
 * the site's business, not this plugin's — so the first page is read to learn
 * that, and the pages a requested slice falls in are read from there. Each page
 * of the app is one or two requests, and a page deep into a long watchlist
 * reads only the pages it covers.
 */
export async function fetchWatchlist(
  username: string,
  options: { offset: number; limit: number },
  source: ListSource = { kind: "watchlist" },
): Promise<{ films: Film[]; hasMore: boolean }> {
  const offset = Math.max(0, Math.round(options.offset));
  const limit = Math.min(MAX_ITEMS, Math.max(1, Math.round(options.limit)));

  const first = parseWatchlist(await readPage(listUrl(source, username, 1)));
  const perPage = Math.max(1, first.films.length);
  const startPage = Math.floor(offset / perPage) + 1;

  const collected: Film[] = [...first.films];
  let page = 1;
  let hasNext = first.hasNext;

  // Everything before the requested slice is not drawn, but it is what the
  // slice's own page numbers are counted from, so those pages are read too.
  while (page < startPage && hasNext && page < MAX_PAGE_FETCHES) {
    page += 1;
    const next = parseWatchlist(await readPage(listUrl(source, username, page)));
    collected.push(...next.films);
    hasNext = next.hasNext;
  }
  while (
    collected.length < offset + limit &&
    hasNext &&
    page < MAX_PAGE_FETCHES
  ) {
    page += 1;
    const next = parseWatchlist(await readPage(listUrl(source, username, page)));
    collected.push(...next.films);
    hasNext = next.hasNext;
  }

  const seen = new Set<string>();
  const unique = collected.filter((film) =>
    seen.has(film.id) ? false : (seen.add(film.id), true),
  );
  return {
    films: unique.slice(offset, offset + limit),
    hasMore: hasNext,
  };
}

/**
 * The poster a film's own page names, or null when it names none. The watchlist
 * grid does not ship its pictures, so this is where a card's poster comes from
 * the first time that film is drawn; the plugin caches the address.
 */
export async function fetchPosterUrl(slug: string): Promise<string | null> {
  const preview = parseFilm(await readPage(filmUrl(slug)));
  return preview.imageUrl?.startsWith("https://") ? preview.imageUrl : null;
}

/** One film's preview fields, read from its own page. */
export async function fetchPreview(slug: string): Promise<Preview> {
  const preview = parseFilm(await readPage(filmUrl(slug)));
  if (!preview.title && !preview.description && !preview.imageUrl) {
    throw new PluginError("no_data", "Letterboxd answered without a synopsis.");
  }
  return preview;
}
