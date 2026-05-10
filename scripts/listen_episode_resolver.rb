# frozen_string_literal: true

# Beriker episode_availability-rader med Spotify- / Apple-episode-URLer.
#
# Spotify: henter alle episoder i showet via Web API (client credentials).
#   Krever SPOTIFY_CLIENT_ID og SPOTIFY_CLIENT_SECRET i miljøet (opprett app på
#   https://developer.spotify.com/). Uten dette hoppes Spotify-episode over.
#
# Apple: henter opptil 200 siste episoder fra iTunes Lookup og matcher på
#   episodeGuid (Buzzsprout) eller samme utgivelsesdato + tittel-likhet.

require "base64"
require "json"
require "net/http"
require "uri"

require_relative "buzzsprout_match_core"

module ListenEpisodeResolver
  module_function

  ITUNES_LOOKUP_EP_LIMIT = 200
  APPLE_URL_PREFIX_SWAP = %r{\Ahttps://podcasts\.apple\.com/(?:[a-z]{2})/}.freeze

  def normalize_apple_podcasts_url(url)
    u = url.to_s.strip
    return nil if u.empty?
    u.sub(APPLE_URL_PREFIX_SWAP, "https://podcasts.apple.com/no/")
  end

  def fetch_itunes_episode_rows(podcast_id)
    uri = URI("https://itunes.apple.com/lookup?id=#{podcast_id}&entity=podcastEpisode&limit=#{ITUNES_LOOKUP_EP_LIMIT}")
    body = Net::HTTP.get(uri)
    j = JSON.parse(body)
    (j["results"] || []).select { |r| r["kind"] == "podcast-episode" }
  rescue StandardError => e
    warn "iTunes lookup failed: #{e.class}: #{e.message}"
    []
  end

  def spotify_access_token(client_id, client_secret)
    uri = URI("https://accounts.spotify.com/api/token")
    req = Net::HTTP::Post.new(uri)
    req["Authorization"] = "Basic #{Base64.strict_encode64("#{client_id}:#{client_secret}")}"
    req.set_form_data("grant_type" => "client_credentials")
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 60, open_timeout: 30) do |h|
      h.request(req)
    end
    unless res.code == "200"
      warn "Spotify token failed HTTP #{res.code}"
      return nil
    end
    JSON.parse(res.body)["access_token"]
  rescue StandardError => e
    warn "Spotify token error: #{e.class}: #{e.message}"
    nil
  end

  def fetch_all_spotify_show_episodes(token, show_id, market: "NO")
    out = []
    url = "https://api.spotify.com/v1/shows/#{show_id}/episodes?market=#{market}&limit=50"
    loop do
      uri = URI(url)
      req = Net::HTTP::Get.new(uri)
      req["Authorization"] = "Bearer #{token}"
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 90, open_timeout: 30) do |h|
        h.request(req)
      end
      unless res.code == "200"
        warn "Spotify episodes page failed HTTP #{res.code}"
        break
      end
      j = JSON.parse(res.body)
      (j["items"] || []).each { |it| out << it if it }
      url = j["next"]
      break if url.nil? || url.to_s.empty?
      sleep 0.15
    end
    out
  rescue StandardError => e
    warn "Spotify fetch episodes error: #{e.class}: #{e.message}"
    []
  end

  def pick_apple_url(rows, buzz_guid, buzz_title, buzz_pubdate)
    return nil if rows.empty? || buzz_title.to_s.strip.empty?

    if buzz_guid && !buzz_guid.to_s.strip.empty?
      hit = rows.find { |r| r["episodeGuid"].to_s.strip == buzz_guid.to_s.strip }
      u = hit&.dig("trackViewUrl")
      nu = normalize_apple_podcasts_url(u)
      return nu if nu && !nu.empty?
    end

    day = buzz_pubdate.to_s.strip[0, 10]
    if day.match?(/\A\d{4}-\d{2}-\d{2}\z/)
      same_day = rows.select do |r|
        (r["releaseDate"].to_s[0, 10] == day)
      end
      if same_day.size == 1
        u = same_day.first["trackViewUrl"]
        nu = normalize_apple_podcasts_url(u)
        return nu if nu && !nu.empty?
      elsif same_day.size > 1
        nb = BuzzsproutMatchCore.normalize_title(buzz_title)
        best = nil
        best_s = -1.0
        same_day.each do |r|
          nt = BuzzsproutMatchCore.normalize_title(r["trackName"].to_s)
          s = BuzzsproutMatchCore.text_similarity(nb, nt)
          if s > best_s
            best_s = s
            best = r
          end
        end
        if best && best_s >= 0.72
          nu = normalize_apple_podcasts_url(best["trackViewUrl"])
          return nu if nu && !nu.empty?
        end
      end
    end

    nil
  end

  def pick_spotify_episode_url(episodes, buzz_title, buzz_pubdate, buzz_duration_sec)
    return nil if episodes.nil? || episodes.empty? || buzz_title.to_s.strip.empty?

    nb = BuzzsproutMatchCore.normalize_title(buzz_title)
    day = buzz_pubdate.to_s.strip[0, 10]
    best = nil
    best_score = -1.0

    episodes.each do |ep|
      next if ep.nil?

      ns = BuzzsproutMatchCore.normalize_title(ep["name"].to_s)
      sim = BuzzsproutMatchCore.text_similarity(nb, ns)
      score = sim
      rday = ep["release_date"].to_s[0, 10]
      if day.match?(/\A\d{4}-\d{2}-\d{2}\z/) && rday == day
        score += 0.12
      end
      dms = ep["duration_ms"]
      if buzz_duration_sec.is_a?(Numeric) && dms.is_a?(Integer)
        dd = ((buzz_duration_sec.to_f * 1000) - dms).abs
        score += 0.08 if dd < 90_000
        score -= 0.12 if dd > 300_000
      end
      score = [score, 1.0].min
      if score > best_score
        best_score = score
        best = ep
      end
    end

    return nil if best.nil? || best_score < 0.58

    u = best.dig("external_urls", "spotify")
    u.to_s.strip.empty? ? nil : u.to_s.strip
  end

  def enrich_results!(results, apple_podcast_id:, spotify_show_id:)
    rows = fetch_itunes_episode_rows(apple_podcast_id)

    spotify_episodes = nil
    cid = ENV["SPOTIFY_CLIENT_ID"].to_s.strip
    sec = ENV["SPOTIFY_CLIENT_SECRET"].to_s.strip
    if !cid.empty? && !sec.empty?
      token = spotify_access_token(cid, sec)
      if token
        spotify_episodes = fetch_all_spotify_show_episodes(token, spotify_show_id)
        warn "Spotify: fetched #{spotify_episodes.size} episode(s) for matching."
      end
    else
      warn "Spotify: mangler SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET — bruker kun show-URL i Jekyll (ikke per episode)."
    end

    results.each do |e|
      next unless e["buzzsprout_title"]
      next unless %w[also_free uncertain].include?(e["availability"])

      buzz_guid = e["buzzsprout_guid"]
      buzz_title = e["buzzsprout_title"]
      buzz_day = e["buzzsprout_pubdate"]
      dhint = e["buzzsprout_duration_hint_sec"]

      apple_u = pick_apple_url(rows, buzz_guid, buzz_title, buzz_day)
      e["listen_apple_episode_url"] = apple_u if apple_u

      if spotify_episodes
        spot_u = pick_spotify_episode_url(spotify_episodes, buzz_title, buzz_day, dhint)
        e["listen_spotify_episode_url"] = spot_u if spot_u
      end
    end

    results
  end
end
