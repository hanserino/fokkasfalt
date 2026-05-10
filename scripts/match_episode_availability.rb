#!/usr/bin/env ruby
# frozen_string_literal: true

# Reads _episodes/*.md, fetches Buzzsprout RSS, fuzzy-matches (title, optional #,
# date, duration). Writes _data/episode_availability.yml for Jekyll.
#
#   ruby scripts/match_episode_availability.rb
#
# Env: BUZZSPROUT_RSS_URL (default: https://feeds.buzzsprout.com/145661.rss)

require "open-uri"
require "rss"
require "fileutils"
require "yaml"
require_relative "buzzsprout_match_core"

CORE = BuzzsproutMatchCore

ROOT = File.expand_path("..", __dir__)
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

free_n = results.count { |r| r["availability"] == "also_free" }
unc_n = results.count { |r| r["availability"] == "uncertain" }
only_n = results.count { |r| r["availability"] == "patreon_only" }

out = {
  "meta" => {
    "generated_at" => Time.now.utc.iso8601,
    "buzzsprout_feed" => url,
    "patreon_source" => "_episodes/*.md (import fra Patreon-RSS)",
    "note" =>
      "Automatisk fuzzy-match (tittel, ev. #nr, dato, varighet). «Usikker» bør verifiseres manuelt."
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
