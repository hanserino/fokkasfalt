#!/usr/bin/env ruby
# frozen_string_literal: true

# Reads _episodes/*.md, fetches Buzzsprout RSS, fuzzy-matches (title, optional #,
# date, duration). Writes _data/episode_availability.yml for Jekyll.
#
#   ruby scripts/match_episode_availability.rb
#
# Env: BUZZSPROUT_RSS_URL (default: https://feeds.buzzsprout.com/145661.rss)
#      SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET — for episode-spesifikke Spotify-lenker (client credentials)
#      APPLE_PODCAST_ITUNES_ID, SPOTIFY_SHOW_ID — overstyrr standard (matcher _config.yml listen)
#
# Last automatisk .env fra prosjektroten hvis filen finnes (gitignored). Spotify «redirect URI»
# i developer dashboard brukes ikke av dette scriptet — kun client credentials, ingen innlogging.

require "open-uri"
require "rss"
require "fileutils"
require "yaml"
require_relative "buzzsprout_match_core"
require_relative "listen_episode_resolver"

CORE = BuzzsproutMatchCore

def env_int(key, default)
  v = ENV[key].to_s.strip
  return default if v.empty?
  Integer(v, 10)
rescue ArgumentError
  default
end

def load_dotenv_from_file(path)
  return unless File.file?(path)

  File.foreach(path) do |line|
    s = line.strip
    next if s.empty? || s.start_with?("#")

    m = s.match(/\A([A-Za-z_][A-Za-z0-9_]*)=(.*)\z/)
    next unless m

    key, val = m[1], m[2].strip
    next if key.empty?

    if (val.start_with?('"') && val.end_with?('"')) || (val.start_with?("'") && val.end_with?("'"))
      val = val[1..-2]
    end

    next if val.nil?

    ENV[key] = val if ENV[key].to_s.strip.empty?
  end
end

ROOT = File.expand_path("..", __dir__)
load_dotenv_from_file(File.join(ROOT, ".env"))
EP_DIR = File.join(ROOT, "_episodes")
OUT_YML = File.join(ROOT, "_data", "episode_availability.yml")

url = ENV["BUZZSPROUT_RSS_URL"].to_s.strip.empty? ? CORE::BUZZ_DEFAULT : ENV["BUZZSPROUT_RSS_URL"].strip

raw_items =
  begin
    CORE.parse_feed_rss2(url)
  rescue OpenURI::HTTPError, SocketError, SystemCallError, Errno::ECONNREFUSED, Errno::ETIMEDOUT => e
    warn "Failed to fetch Buzzsprout: #{e.class}: #{e.message}"
    exit 1
  rescue RSS::Error => e
    warn "Failed to parse Buzzsprout RSS: #{e.class}: #{e.message}"
    exit 1
  end

buzz = raw_items.map { |it| CORE.buzz_item_to_h(it) }
pool = {}
buzz.each_with_index { |b, i| pool[i] = b }

patreon_eps = CORE.load_episodes_from_disk(EP_DIR)
results = CORE.greedy_match_patreon_to_buzz!(patreon_eps, pool)

apple_id = env_int("APPLE_PODCAST_ITUNES_ID", 1_332_829_214)
spotify_show = ENV["SPOTIFY_SHOW_ID"].to_s.strip
spotify_show = "1s8OvAXNcqRa6oncqakhdg" if spotify_show.empty?

ListenEpisodeResolver.enrich_results!(results, apple_podcast_id: apple_id, spotify_show_id: spotify_show)

free_n = results.count { |r| r["availability"] == "also_free" }
unc_n = results.count { |r| r["availability"] == "uncertain" }
only_n = results.count { |r| r["availability"] == "patreon_only" }

out = {
  "meta" => {
    "generated_at" => Time.now.utc.iso8601,
    "buzzsprout_feed" => url,
    "patreon_source" => "_episodes/*.md (import fra Patreon-RSS)",
    "note" =>
      "Automatisk fuzzy-match (tittel, ev. #nr, dato, varighet). «Usikker» bør verifiseres manuelt. " \
      "listen_*_episode_url: Apple via iTunes Lookup (guid/dato), Spotify ved SPOTIFY_CLIENT_ID/SECRET."
  },
  "stats" => {
    "total" => results.size,
    "also_free" => free_n,
    "uncertain" => unc_n,
    "patreon_only" => only_n,
    "unmatched_buzzsprout" => pool.size
  },
  "episodes" => results
}

FileUtils.mkdir_p(File.dirname(OUT_YML))
File.write(OUT_YML, "#{out.to_yaml(line_width: -1)}")
puts "Wrote #{OUT_YML} (#{results.size} episodes, #{free_n} also_free, #{unc_n} uncertain, #{only_n} patreon_only, #{pool.size} buzz-only)"
