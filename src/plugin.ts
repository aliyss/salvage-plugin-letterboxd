import { fetchPreview, fetchWatchlist, filmSlugFrom, usernameOf } from "./letterboxd";
import { PluginError, serve } from "./sdk";
import { keepStills } from "./still";

import type { Data, Paging, Subject } from "./sdk";

const DEFAULT_PER_PAGE = 30;
const MIN_PER_PAGE = 5;
const MAX_PER_PAGE = 50;

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
 * One page of the profile's watchlist.
 *
 * The tiles' pictures are put in by the site's own script, so a tile usually
 * arrives without one; a card then paints the colour block it would otherwise
 * leave empty, and the poster is filed the first time a film's own page is
 * opened. Nothing is stored: the watchlist is read when the canvas asks.
 */
async function catalogue(
  settings: Record<string, unknown>,
  paging: Paging | undefined,
): Promise<Data> {
  const username = usernameOf(settings.username);
  if (!username) {
    throw new PluginError(
      "bad_subject",
      "Set the Letterboxd username this canvas reads, in the canvas's settings.",
    );
  }

  const { offset, limit } = pageOf(paging, perPageOf(settings.perPage));
  const page = await fetchWatchlist(username, { offset, limit });
  const covers = await keepStills(page.films.map((film) => film.poster));

  return {
    kind: "film-catalogue",
    text: JSON.stringify({
      items: page.films.map((film, index) => ({
        id: film.id,
        title: film.title,
        year: film.year,
        poster: film.poster,
        cover: covers[index] ?? null,
        color: null,
        overview: null,
        url: film.url,
      })),
      known: [],
      hasMore: page.hasMore,
    }),
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

  return { kind: "link-preview", text: JSON.stringify(await fetchPreview(slug)) };
}

export default () =>
  serve(async ({ command, params }) => {
    if (command === "catalogue") {
      return await catalogue(params.settings ?? {}, params.paging);
    }
    if (command === "preview") {
      return await preview(params.subject);
    }

    throw new PluginError("unsupported", `Unknown command ${command}.`);
  });
