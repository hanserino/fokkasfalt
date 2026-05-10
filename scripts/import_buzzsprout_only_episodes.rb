#!/usr/bin/env ruby
# frozen_string_literal: true

# Oppretter _episodes/*.md for Buzzsprout-episoder som ikke fuzzy-matcher noen
# eksisterende arkiv-post (samme basseng som «unmatched» i match-scriptet).
#
#   ruby scripts/import_buzzsprout_only_episodes.rb
#
# Env:
#   BUZZSPROUT_RSS_URL — valgfritt (samme standard som matcher)
#   BUZZ_IMPORT_DRY_RUN=1 — skriv ikke filer; logg planlagte filnavn

require "digest"
require "fileutils"
require "yaml"
require_relative "buzzsprout_match_core"

ROOT = File.expand_path("..", __dir__)
EP_DIR = File.join(ROOT, "_episodes")
CORE = BuzzsproutMatchCore

def slugify(title)
  s = title.to_s.downcase.tr("æ", "ae").tr("ø", "o").tr("å", "aa")
  s = s.gsub(/[^\w\s-]+/, "").strip.gsub(/\s+/, "-").gsub(/-+/, "-").gsub(/\A-+|-+\z/, "")
  s = "episode" if s.empty?
  s[0, 56]
end

def episode_hash(guid, link, title)
  raw = [guid, link, title].find { |x| x && !x.to_s.strip.empty? }
  Digest::SHA1.hexdigest(raw.to_s)[0, 10]
end

def safe_filename(slug)
  slug.gsub(/[^a-z0-9._-]/i, "-").squeeze("-").gsub(/\A-+|-+\z/, "")
end

def format_duration_hms(seconds)
  return nil if seconds.nil? || !seconds.is_a?(Integer) || !seconds.positive?

  h = seconds / 3600
  m = (seconds % 3600) / 60
  sec = seconds % 60
  if h.positive?
    format("%d:%02d:%02d", h, m, sec)
  else
    format("%d:%02d", m, sec)
  end
end

def iso8601_duration_from_seconds(sec)
  return nil if sec.nil? || !sec.is_a?(Integer) || !sec.positive?

  h = sec / 3600
  m = (sec % 3600) / 60
  s = sec % 60
  buf = +"PT"
  buf << "#{h}H" if h.positive?
  buf << "#{m}M" if m.positive? || h.positive?
  buf << "#{s}S" if s.positive? || buf == "PT"
  buf
end

def date_to_iso8601(d)
  case d
  when Time
    d.utc.iso8601
  when String
    s = d.to_s.strip
    return nil if s.empty?

    begin
      Time.parse(s).utc.iso8601
    rescue ArgumentError
      warn "Skipping invalid date string #{s.inspect}"
      nil
    end
  else
    nil
  end
end

def write_episode_file(path, fm)
  File.write(path, "#{YAML.dump(fm)}---\n")
end

url = ENV["BUZZSPROUT_RSS_URL"].to_s.strip.empty? ? CORE::BUZZ_DEFAULT : ENV["BUZZSPROUT_RSS_URL"].strip
dry = !ENV["BUZZ_IMPORT_DRY_RUN"].to_s.strip.empty? && ENV["BUZZ_IMPORT_DRY_RUN"] != "0"

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
CORE.greedy_match_patreon_to_buzz!(patreon_eps, pool)

if pool.empty?
  puts "Ingen Buzzsprout-episoder uten treff i arkivet (pool tom)."
  exit 0
end

FileUtils.mkdir_p(EP_DIR)

written = 0
skipped = 0
pool.keys.sort.each do |idx|
  raw = raw_items[idx]
  bz = pool[idx]
  title = raw[:title].to_s
  next if title.empty?

  link = raw[:link].to_s.strip
  if link.empty?
    warn "Skip (mangler side-URL): #{title.inspect}"
    skipped += 1
    next
  end

  slug = safe_filename("#{slugify(title)}-#{episode_hash(raw[:guid], link, title)}")
  path = File.join(EP_DIR, "#{slug}.md")

  if File.file?(path)
    puts "Finnes allerede: #{path}"
    skipped += 1
    next
  end

  date_iso = date_to_iso8601(raw[:date])

  fm = {
    "title" => title,
    "description" => raw[:excerpt].to_s,
    "buzzsprout_url" => link,
    "buzzsprout_guid" => raw[:guid].to_s,
    "buzzsprout_only" => true,
    "cover" => raw[:image].to_s,
    "og_type" => "article"
  }
  fm["date"] = date_iso if date_iso

  sec = CORE.parse_itunes_duration(raw[:duration_raw])
  if sec
    lbl = format_duration_hms(sec)
    fm["duration"] = lbl if lbl
    iso = iso8601_duration_from_seconds(sec)
    fm["duration_iso8601"] = iso if iso
  end

  if dry
    puts "[dry-run] ville opprettet #{path}"
    written += 1
  else
    write_episode_file(path, fm)
    puts "Skrev #{path}"
    written += 1
  end
end

puts dry ? "Dry-run: #{written} fil(er) ville blitt opprettet, #{skipped} hoppet over." :
     "Ferdig: #{written} nye episoder i _episodes/, #{skipped} hoppet over."
puts "Tips: kjør deretter ruby scripts/match_episode_availability.rb for oppdatert _data/episode_availability.yml"
