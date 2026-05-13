# Føkk Asfalt (Jekyll → statisk HTML)

Nettstedet **fokkasfalt.no** (statisk trakt bygget med Jekyll). Kan også peke flere domenenavn hit (f.eks. **ultraloping.no**) med redirect.

## Publisere på GitHub Pages

1. Push repo til GitHub.
2. **Settings → Pages → Build and deployment**: kilde **Deploy from a branch**, branch **`main`**, mappe **`/` (root)**.  
   Uten `.nojekyll` kjører GitHub **Jekyll** og skriver ferdig `_site/` til nett (med `Gemfile`/`Gemfile.lock` som referanse; Pages bruker egne versjoner av samme verktøy).

**Egendefinert domene:** Under Pages, sett **Custom domain** til `fokkasfalt.no` og la repo-root inneholde **`CNAME`** med det domenet. Pek DNS (A/AAAA eller CNAME) mot GitHub Pages etter [dokumentasjonen](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site). **To domener:** GitHub tillater én primær `CNAME`; pek det andre domenet med **301-redirect** hos DNS/registrar mot primær-URL.

## Lokal forhåndsvisning

Bruk **Ruby 3.x** (se `.ruby-version`). Etter `git clone`, kjør alltid `bundle install` slik at `Gemfile.lock` matcher din maskin.

```bash
bundle install
bundle exec jekyll serve
```

Åpne adressen terminalen viser (vanligvis `http://127.0.0.1:4000`). Kun statiske filer etter bygg: `bundle exec jekyll build` skriver til `_site/`.

## Kanonisk URL (SEO)

Jekyll bruker `url` og `baseurl` i `_config.yml`. **`url`** er satt til `https://fokkasfalt.no` (kanoniske lenker og sitemap).
Oppdater også **`robots.txt`** hvis sitemap-URL skal endres (pluginen **jekyll-sitemap** genererer `/sitemap.xml`).

## Giscus (kommentarer på episoder)

Episoder (`layout: episode`) kan vise [Giscus](https://github.com/giscus/giscus)-kommentarer (bygger på **GitHub Discussions**). Oppsett styres av **`giscus:`** i `_config.yml` (inkl. `category` og `category_id` fra [giscus.app](https://giscus.app)).

1. I GitHub-repoet: **Settings → General → Features → Discussions** (slå på).
2. Opprett en **Discussion-kategori** til kommentarer (f.eks. **Episode-kommentar**). Navnet må stemme med `giscus.category` i `_config.yml`.
3. Installer [giscus GitHub App](https://github.com/apps/giscus) på repoet `hanserino/fokkasfalt` (eller det repoet du bruker).
4. Gå til [giscus.app](https://giscus.app), fyll inn repo og kategori, velg **Page ↔️ Discussions mapping: pathname** (én tråd per episode-URL), kopier **`data-category-id`** inn i `giscus.category_id` i `_config.yml`, og push.

Moderering og varsler skjer via GitHub Discussions. Brukere trenger GitHub-konto for å skrive.

**Kommentartall på `/episoder/`:** Listen kan vise «N kommentarer» per episode når tallet er hentet inn. Fila [`_data/giscus_comment_counts.yml`](_data/giscus_comment_counts.yml) bygges av [`scripts/fetch_giscus_comment_counts.rb`](scripts/fetch_giscus_comment_counts.rb) (GraphQL mot GitHub, filtrert på `giscus.category_id`). Kjør GitHub Actions-workflowen **«Giscus comment counts»** (manuelt eller daglig 06:25 UTC), eller lokalt med `GITHUB_TOKEN` som har **discussions read** på repoet. Statisk Jekyll har ikke tilgang til GitHub uten token ved bygg.

## Patreon-RSS → episoder (`/episoder/`)

[Ruby-skriptet](scripts/fetch_episodes.rb) `scripts/fetch_episodes.rb` henter master-RSS og skriver én **Markdown-fil per episode** i **`_episodes/`** (Jekyll *collection*). **Jekyll** bygger deretter:

- **`/episoder/`** — oversikt (`episoder.md` + layout)
- **`/episoder/<slug>/`** — én statisk side per episode (layout `episode`)

Daglig oppdatering: GitHub Action [`.github/workflows/patreon-episodes.yml`](.github/workflows/patreon-episodes.yml) kjører skriptet og committer endringer i **`_episodes/`** (ikke ferdig HTML).

### Oppsett

1. Legg inn repo-secret **`PATREON_RSS_URL`** (hele RSS-URL inkl. `auth=` og `show=`). **Ikke** commit URL med token.
2. Valgfritt: repo-variabel **`SITE_ORIGIN`** er foreløpig ubrukt av skriptet; kanoniske URL-er styres via `_config.yml` → `url`.
3. Kjør **Actions → Regenerate Patreon episodes → Run workflow** én gang, eller vent på cron (05:20 UTC).
4. Lokalt: legg `PATREON_RSS_URL` i **`.env`** i prosjektmappa (se `.env.example`), eller `export …`, deretter `ruby scripts/fetch_episodes.rb` — skriptet leser `.env` automatisk. Valgfritt: `EPISODE_LIMIT=5` ved testing.

**«Ingen episoder» på `/episoder/`:** Da finnes det ingen `*.md` under `_episodes/` ennå — verken etter import lokalt eller fra Actions. Kjør import (over), slå av/på `jekyll serve`, eller push når Actions har committet nye filer.

Mangler `PATREON_RSS_URL` i Actions, hoppes import over (ingen feil).

**Sikkerhet:** Har RSS med `auth=` lekket et sted — **rotér** feed-URL i Patreon og oppdater secreten.

## Viktige filer

| Fila | Rolle |
|------|--------|
| `_config.yml` | Jekyll-innstillinger, `episodes`-collection |
| `index.md` | Forside (`layout: home`) |
| `episoder.md` | Oversikt `/episoder/` |
| `_layouts/` | HTML-maler |
| `_includes/giscus.html` | Giscus-innboks (episoder), styrt av `giscus:` i `_config.yml` |
| `_episodes/*.md` | Episodeinnhold (genereres av Ruby, bygges av Jekyll) |
| `scripts/fetch_giscus_comment_counts.rb` | Oppdaterer `_data/giscus_comment_counts.yml` (Giscus-tall for episodelisten) |
| `css/styles.css` | Stiler |
| `Gemfile` / `Gemfile.lock` | Lokalt Jekyll (+ `jekyll-sitemap`) |

**Node** brukes ikke lenger (før brukt til samme import).
