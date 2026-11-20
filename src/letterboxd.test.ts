import { describe, expect, test } from "bun:test";

import {
  decodeEntities,
  filmSlugFrom,
  filmUrl,
  parseFilm,
  parseWatchlist,
  usernameOf,
  watchlistUrl,
} from "./letterboxd";

/**
 * One tile as Letterboxd writes it: the film in the attributes, the picture
 * left for the site's own script, which is why there is no poster here.
 */
const TILE = (slug: string, name: string, next: string): string =>
  `<li class="griditem">
 <div class="react-component" data-component-class="LazyPoster" data-item-name="${name}"
 data-item-slug="${slug}" data-item-link="/film/${slug}/"
 data-item-full-display-name="${name}"
 data-postered-identifier='{&quot;lid&quot;:&quot;KRbM&quot;,&quot;uid&quot;:&quot;film:1116755&quot;}'
 data-resolvable-poster-path='{&quot;postered&quot;:{&quot;lid&quot;:&quot;KRbM&quot;}}'
 data-target-link="/film/${next}/">
 <div class="poster film-poster"> <img src="https://s.ltrbxd.com/static/img/empty-poster-125.png"
 class="image" width="125" height="187" alt="${name}"/> </div> </div>
</li>`;

const WATCHLIST = `<html><body><ul class="poster-list">${TILE(
  "black-bag-2025",
  "Black Bag (2025)",
  "black-bag-2025",
)}${TILE("la-gradiva", "La Gradiva", "la-gradiva")}</ul>
<div class="pagination"><a class="next" href="/dave/watchlist/page/2/">Next</a></div></body></html>`;

/** A film page as it arrives: the schema.org block wrapped in a comment. */
const FILM = `<html><head>
<meta property="og:title" content="The Shawshank Redemption (1994)" />
<script type="application/ld+json">
/* <![CDATA[ */
{"image":"https://a.ltrbxd.com/resized/film-poster/shawshank.jpg","@type":"Movie",
 "name":"The Shawshank Redemption",
 "description":"Imprisoned in the 1940s, Andy Dufresne begins a quiet campaign.",
 "genre":["Crime","Drama"]}
/* ]]> */
</script></head><body>a page</body></html>`;

describe("usernameOf", () => {
  test("takes a profile name and nothing that is not one", () => {
    expect(usernameOf("dave")).toBe("dave");
    expect(usernameOf("  @dave_vis ")).toBe("dave_vis");
    expect(usernameOf("dave-vis")).toBe("dave-vis");
    expect(usernameOf("dave vis")).toBeNull();
    expect(usernameOf("dave/../evil")).toBeNull();
    expect(usernameOf("")).toBeNull();
    expect(usernameOf(undefined)).toBeNull();
    expect(usernameOf("x".repeat(41))).toBeNull();
  });
});

describe("filmSlugFrom", () => {
  test("reads the slug out of the addresses a film link comes in", () => {
    expect(
      filmSlugFrom("https://letterboxd.com/film/the-shawshank-redemption/"),
    ).toBe("the-shawshank-redemption");
    expect(filmSlugFrom("https://www.letterboxd.com/film/heat")).toBe("heat");
    expect(
      filmSlugFrom("http://letterboxd.com/film/heat/?ref_=x#comments"),
    ).toBe("heat");
  });

  test("is not fooled by another page or another host", () => {
    expect(filmSlugFrom("https://letterboxd.com/dave/films/")).toBeNull();
    expect(filmSlugFrom("https://letterboxd.com/film/")).toBeNull();
    expect(filmSlugFrom("https://letterboxd.com.evil.test/film/heat/")).toBeNull();
    expect(filmSlugFrom("https://www.imdb.com/title/tt0111161/")).toBeNull();
    expect(filmSlugFrom(null)).toBeNull();
  });
});

describe("watchlistUrl", () => {
  test("names the profile's first page and the pages after it", () => {
    expect(watchlistUrl("dave", 1)).toBe(
      "https://letterboxd.com/dave/watchlist/",
    );
    expect(watchlistUrl("dave", 3)).toBe(
      "https://letterboxd.com/dave/watchlist/page/3/",
    );
    expect(filmUrl("heat")).toBe("https://letterboxd.com/film/heat/");
  });
});

describe("decodeEntities", () => {
  test("reads the entities Letterboxd writes into its attributes", () => {
    expect(decodeEntities("Black Bag &amp; Co.")).toBe("Black Bag & Co.");
    expect(decodeEntities("&quot;Heat&quot;")).toBe('"Heat"');
    expect(decodeEntities("&#39;71")).toBe("'71");
    expect(decodeEntities("&#x27;71")).toBe("'71");
    expect(decodeEntities("&unknown; stays")).toBe("&unknown; stays");
  });
});

describe("parseWatchlist", () => {
  test("reads the films, their years and their pages", () => {
    const page = parseWatchlist(WATCHLIST);
    expect(page.films).toEqual([
      {
        id: "black-bag-2025",
        title: "Black Bag",
        year: 2025,
        url: "https://letterboxd.com/film/black-bag-2025/",
        poster: null,
      },
      {
        id: "la-gradiva",
        title: "La Gradiva",
        year: null,
        url: "https://letterboxd.com/film/la-gradiva/",
        poster: null,
      },
    ]);
    expect(page.hasNext).toBe(true);
  });

  test("a tile the site repeats is drawn once", () => {
    const twice = `<ul>${TILE("heat", "Heat (1995)", "heat")}${TILE(
      "heat",
      "Heat (1995)",
      "heat",
    )}</ul>`;
    const page = parseWatchlist(twice);
    expect(page.films).toHaveLength(1);
    expect(page.films[0]?.year).toBe(1995);
  });

  test("the last page of a watchlist says so", () => {
    expect(parseWatchlist(`<ul>${TILE("heat", "Heat (1995)", "heat")}</ul>`).hasNext).toBe(
      false,
    );
  });

  test("a page with no tiles is an empty watchlist, not a failure", () => {
    expect(parseWatchlist("<html><body>No films yet</body></html>")).toEqual({
      films: [],
      hasNext: false,
    });
  });
});

describe("parseFilm", () => {
  test("reads the name, the synopsis and the poster out of the schema block", () => {
    expect(parseFilm(FILM)).toEqual({
      title: "The Shawshank Redemption",
      description:
        "Imprisoned in the 1940s, Andy Dufresne begins a quiet campaign.",
      imageUrl: "https://a.ltrbxd.com/resized/film-poster/shawshank.jpg",
    });
  });

  test("a page without one falls back to its meta tags", () => {
    const bare = `<html><head>
      <meta property="og:title" content="Heat (1995)" />
      <meta property="og:description" content="A crew, a cop, a city." />
      <meta property="og:image" content="https://a.ltrbxd.com/resized/heat.jpg" />
      </head></html>`;
    expect(parseFilm(bare)).toEqual({
      title: "Heat (1995)",
      description: "A crew, a cop, a city.",
      imageUrl: "https://a.ltrbxd.com/resized/heat.jpg",
    });
  });

  test("a page with neither answers with nothing it can use", () => {
    expect(parseFilm("<html><body>blocked</body></html>")).toEqual({
      title: null,
      description: null,
      imageUrl: null,
    });
  });
});
