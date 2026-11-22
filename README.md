# Letterboxd for Salvage

A [Salvage](https://github.com/aliyss/salvage-web) plugin that adds a
**Watchlist** canvas read from a public Letterboxd profile, and fills in the
previews of links to Letterboxd films. Everything is read by the **Salvage
Helper** on your own computer; nothing about the watchlist reaches the server.

## What it adds

- A canvas, which works like any other: a URL, an entry in the canvas switcher,
  and a page of its own. You name it and choose its route in the plugin's
  settings.
- One card per film on the profile's watchlist, twenty at a time, loading more
  as you scroll. A card carries the film's name, its year, and a link to its
  Letterboxd page. Its poster is filed on this computer the first time the card
  is drawn, and the colour that poster leads with is what the colour view sorts
  by.
- A note for any card. Notes are ordinary Salvage notes — Markdown, tags,
  mentions, Trash — stored on the canvas the plugin added.
- **Link previews.** A link to a Letterboxd film whose page came back with no
  synopsis or picture is filled in from the film's own page: its description
  and its poster.

## No sign-in

A Letterboxd watchlist is public, so there is no token, no password and no
cookie: the canvas reads the profile you name. Set the username in the canvas's
settings; the profile has to be public for the grid to be served at all.

## Where the data comes from

Letterboxd has no public API, so what it publishes is what is read:

- `https://letterboxd.com/<username>/watchlist/` — the grid, one request per
  page, and `.../page/<n>/` after it. Each tile names its film in attributes
  (`data-item-name`, `data-item-slug`, `data-item-link`), which is what a card
  is built from.
- `https://letterboxd.com/film/<slug>/` — the schema.org block on a film's page:
  name, description, poster. Its `og:` tags are the fallback. A film's page is
  read once for its poster, and that address is kept in the plugin's cache so a
  later page turn does not ask for it again.

Two things about that shape decide how the canvas behaves:

- **Posters are lazy.** The tiles ship an empty placeholder and the site's own
  script swaps the poster in, so the grid carries no picture. A film whose page
  has never been read is looked up for its poster, within a small budget on a
  first visit; a card still without one paints the colour block it would
  otherwise leave empty, and nothing is guessed from a placeholder URL.
- **Page size is Letterboxd's.** A watchlist page holds a fixed grid of tiles,
  and a canvas asks for a row count of its own. The first page is read to learn
  how many tiles a page holds, and the pages that cover the requested slice are
  read from there — at most four requests for one answer.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Letterboxd username | — | The public profile whose watchlist is drawn |
| How many films | 30 | Between 5 and 50 |

| Canvas name | Watchlist | The name the canvas starts with |
| Canvas route | watchlist | Its URL segment, under your own space |

## Development

```sh
bun install
bun run typecheck
bun test
bun run build     # writes dist/plugin.js
```

The plugin talks to the helper over stdin/stdout with the small SDK in
`src/sdk.ts`; `SALVAGE_PLUGIN_DATA` is the folder it may use for its own files.

## Publishing

`.github/workflows/release.yml` builds, typechecks and tests every push to
`master`, then publishes `manifest.json` and `dist/plugin.js` on a release
tagged `v<version>` from the manifest. Bump the manifest version to cut a new
release; the helper installs a plugin from a repository that publishes both
assets.

## Data

Letterboxd's terms do not allow scraping; this plugin reads the public pages of
one profile the user names, on that user's own computer, for their own use, and
keeps nothing but the pictures it filed. It is not affiliated with, endorsed by,
or certified by Letterboxd.
