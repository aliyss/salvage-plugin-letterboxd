import { loadCache, saveCache } from "./cache";
import { keepCovers, type CoverColours } from "./covers";
import {
  fetchPosterUrl,
  fetchPreview,
  fetchWatchlist,
  filmSlugFrom,
  listSlugFrom,
  usernameOf,
} from "./letterboxd";
import { PluginError, serve } from "./sdk";

import type { Film, ListSource } from "./letterboxd";
import type { Data, Paging, Subject } from "./sdk";

const DEFAULT_PER_PAGE = 30;
const MIN_PER_PAGE = 5;
const MAX_PER_PAGE = 50;
/** How many film pages one answer reads to learn the posters it lacks. */
const POSTER_CONCURRENCY = 3;
/** Past this the cards without one keep the colour block they already paint. */
const POSTER_BUDGET_MS = 5_000;

function perPageOf(value: unknown): number {
  const wanted =
    typeof value === "number" ? Math.round(value) : DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, wanted));
}

/** The page a canvas asked for: where it starts, and how much it holds. */
function pageOf(
  paging: Paging | undefined,
  perPage: number,
): { offset: number; limit: number } {
  const limit = Math.min(
    MAX_PER_PAGE,
    Math.max(MIN_PER_PAGE, Math.round(paging?.limit ?? perPage)),
  );
  return { offset: Math.max(0, Math.round(paging?.offset ?? 0)), limit };
}

/**
 * The profile this plugin reads.
 *
 * The username is the plugin's own sign-in, kept by the helper beside every
 * other credential, so every canvas and every link preview reads the same
 * profile. A canvas made before it moved there still carries the name in its
 * settings, and that one is used until the sign-in writes it.
 */
function usernameFrom(
  settings: Record<string, unknown>,
  secrets: Record<string, string> | undefined,
): string {
  const username =
    usernameOf(secrets?.username) ?? usernameOf(settings.username);
  if (!username) {
    throw new PluginError(
      "bad_subject",
      "Sign in with your Letterboxd username in this plugin's settings first.",
    );
  }
  return username;
}

/**
 * The list a canvas names. The watchlist is the one every canvas starts on, the
 * watched films are the same grid at another address, and a list is named by
 * the last part of its own address.
 */
function sourceFrom(settings: Record<string, unknown>): ListSource {
  if (settings.source === "films") {
    return { kind: "films" };
  }
  if (settings.source === "list") {
    const slug = listSlugFrom(settings.list);
    if (!slug) {
      throw new PluginError(
        "bad_subject",
        "Name the list this canvas shows: the last part of its letterboxd.com address, such as imdb-top-250.",
      );
    }
    return { kind: "list", slug };
  }
  return { kind: "watchlist" };
}

/**
 * The poster address of each film on the page.
 *
 * The grid names the film, not its picture, so a film whose page has never been
 * read is looked up once and the address kept in the cache. A page that already
 * knows its films asks for none of them. Reading a film's page is the slow part
 * of a first visit, so it stops at a budget: a card without a poster by then is
 * drawn as the colour block it already paints.
 */
async function postersFor(
  films: Film[],
  cached: Record<string, string>,
): Promise<(string | null)[]> {
  const urls = films.map((film) => film.poster ?? cached[film.id] ?? null);
  if (urls.every((url) => url !== null)) {
    return urls;
  }

  const deadline = Date.now() + POSTER_BUDGET_MS;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= films.length) {
        return;
      }
      const film = films[index];
      if (urls[index] || !film) {
        continue;
      }
      if (Date.now() >= deadline) {
        return;
      }
      const url = await fetchPosterUrl(film.id).catch(() => null);
      if (url) {
        urls[index] = url;
        cached[film.id] = url;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(POSTER_CONCURRENCY, films.length) },
      worker,
    ),
  );
  return urls;
}

/**
 * One page of the list the canvas names.
 *
 * Cards carry the poster filed on this computer and the colour that poster
 * leads with, read here when the picture is filed — the two things the grid
 * never reports. Nothing is stored about the films themselves: the watchlist is
 * read when the canvas asks, and only the poster cache survives the visit.
 */
async function catalogue(
  settings: Record<string, unknown>,
  secrets: Record<string, string> | undefined,
  paging: Paging | undefined,
): Promise<Data> {
  const username = usernameFrom(settings, secrets);
  const { offset, limit } = pageOf(paging, perPageOf(settings.perPage));
  const page = await fetchWatchlist(
    username,
    { offset, limit },
    sourceFrom(settings),
  );

  const cache = await loadCache();
  const posters = await postersFor(page.films, cache.posters);
  const colours: CoverColours = cache.colours;
  const covers = await keepCovers(posters, colours);
  await saveCache(cache);

  return {
    kind: "film-catalogue",
    text: JSON.stringify({
      items: page.films.map((film, index) => {
        const cover = covers[index] ?? null;
        return {
          id: film.id,
          title: film.title,
          year: film.year,
          poster: posters[index] ?? null,
          cover,
          color: cover ? (colours[cover] ?? null) : null,
          overview: null,
          url: film.url,
        };
      }),
      known: [],
      hasMore: page.hasMore,
    }),
  };
}

/**
 * Whose profile this computer holds. The sign-in card asks this after saving
 * the name, and the helper reports the name only once Letterboxd has served the
 * profile's first page — a private or misspelled name is refused with the
 * reason, on the card.
 */
async function whoami(
  secrets: Record<string, string> | undefined,
): Promise<Data> {
  const username = usernameOf(secrets?.username);
  if (!username) {
    throw new PluginError(
      "bad_subject",
      "Enter the public Letterboxd username this plugin reads.",
    );
  }

  const page = await fetchWatchlist(username, { offset: 0, limit: 1 });
  return {
    kind: "auth",
    text: `${username}${page.films.length === 0 && !page.hasMore ? " (empty watchlist)" : ""}`,
  };
}

/**
 * The synopsis and poster of the film an entry links to, answered only for the
 * fields a page's own preview lacked. One film is one request.
 */
async function preview(subject: Subject | undefined): Promise<Data> {
  const slug = filmSlugFrom(subject?.link?.url);
  if (!slug) {
    throw new PluginError(
      "bad_subject",
      "This entry does not link to a Letterboxd film.",
    );
  }

  return {
    kind: "link-preview",
    text: JSON.stringify(await fetchPreview(slug)),
  };
}

export default () =>
  serve(async ({ command, params }) => {
    if (command === "catalogue") {
      return await catalogue(
        params.settings ?? {},
        params.secrets,
        params.paging,
      );
    }
    if (command === "whoami") {
      return await whoami(params.secrets);
    }
    if (command === "preview") {
      return await preview(params.subject);
    }

    throw new PluginError("unsupported", `Unknown command ${command}.`);
  });
