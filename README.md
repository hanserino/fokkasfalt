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

## Patreon-låst Community

`/community/` er inngangen. Race-kalenderen ligger på `/community/race-kalender/` (gammel URL `/race-kalender-2027/` redirecter dit). Selve kalenderen og tier-sjekken kjører i Cloudflare Worker `workers/patreon-gate/` — GitHub Pages kan ikke holde `client_secret`.

**Ikke** commit eller lim inn Client Secret / access token / refresh token i chat.

### 1. Lokalt `.env`

Kopier `.env.example` og fyll `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`, `PATREON_CREATOR_ACCESS_TOKEN`, `PATREON_CREATOR_REFRESH_TOKEN`.

List tiers:

```bash
ruby scripts/patreon_list_tiers.rb
```

Aktive patroner på kampanjen (gratis og betalende) slipper inn til community og race-kalender. Slack vises bare for tier **Føkk Asfalt** (`7252533`).

### 2. Worker (Cloudflare, gratis)

```bash
cd workers/patreon-gate
npx wrangler login
npx wrangler secret put PATREON_CLIENT_ID
npx wrangler secret put PATREON_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET            # lang tilfeldig streng
npx wrangler secret put PATREON_ALLOW_USER_IDS    # din egen Patreon-bruker-id, så du kommer inn
npx wrangler deploy
```

Kalenderdata ligger i Cloudflare KV (`CALENDAR` / nøkkel `data`). Første import fra Google-arket:

```bash
ruby scripts/import_race_calendar.rb
cd workers/patreon-gate
npx wrangler kv key put data --remote --path calendar.json
npx wrangler deploy
```

Medlemmer legger inn egne løp via skjemaet på `/community/race-kalender/`.

### 3. Offentlig config i `_config.yml`

Sett `patreon_client_id` (Client ID er offentlig) og `patreon_gate_api` til worker-URL-en wrangler skriver ut, f.eks. `https://fokkasfalt-patreon-gate.<konto>.workers.dev`.

## Viktige filer

| Fila | Rolle |
|------|--------|
| `_config.yml` | Jekyll-innstillinger, `episodes`-collection |
| `index.md` | Forside (`layout: home`) |
| `personvern.md` / `vilkar.md` | Personvern og vilkår (Patreon-klient) |
| `community.md` | Patreon-hub `/community/` |
| `community/race-kalender.md` | Skall for medlemskalender |
| `workers/patreon-gate/` | Patreon-innlogging og kalender-API |
| `episoder.md` | Oversikt `/episoder/` |
| `_layouts/` | HTML-maler |
| `_episodes/*.md` | Episodeinnhold (genereres av Ruby, bygges av Jekyll) |
| `scripts/extract_guest_names.py` | Lokalt: NER-navn fra episodetitler → `guest_names_report.csv` (se avsnitt under) |
| `css/styles.css` | Stiler |
| `Gemfile` / `Gemfile.lock` | Lokalt Jekyll (+ `jekyll-sitemap`) |

**Node** trengs bare for å deploye Cloudflare-workeren (`npx wrangler`). Jekyll-siten er ren Ruby.

## Navn i episodetitler (lokalt NER)

Skriptet [`scripts/extract_guest_names.py`](scripts/extract_guest_names.py) går gjennom `title:` i alle `_episodes/*.md`, kjører **spaCy** med den norske modellen **`nb_core_news_sm`** (valgfritt `nb_core_news_lg` for bedre kvalitet) og samler entiteter merket som person (**`PER` / `PERSON`**). Resultatet skrives til **`scripts/guest_names_report.csv`** (og valgfritt JSON med `--json`).

### Oppsett (én gang per maskin)

```bash
cd /path/til/ultramarathon   # prosjektrot
python3 -m venv scripts/.venv-ner
source scripts/.venv-ner/bin/activate   # Windows: scripts\.venv-ner\Scripts\activate
pip install -r scripts/requirements-ner.txt
python -m spacy download nb_core_news_sm
```

### Kjøre

```bash
source scripts/.venv-ner/bin/activate
python scripts/extract_guest_names.py
# eller: python scripts/extract_guest_names.py --out min_rapport.csv --json min_rapport.json
# kun gjester som dukker opp i minst 2 episoder: --min-episodes 2
```

**Merk:** Modellen tar feil av og til (sted, løp, podkast som «person»). Bruk CSV-en som **utkast** og rydd manuelt. `scripts/.venv-ner/` og standard rapportfiler er **`.gitignore`**-et.
