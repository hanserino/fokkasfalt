#!/usr/bin/env ruby
# frozen_string_literal: true

# Scrapes the public Føkk Asfalt Google Calendar into _data/race_catalog.json
# for the race-name combobox (canonical names + typical date).
#
#   ruby scripts/import_race_catalog.rb

require "fileutils"
require "json"
require "net/http"
require "uri"

ROOT = File.expand_path("..", __dir__)
OUT = File.join(ROOT, "_data/race_catalog.json")
ICS_URL = "https://calendar.google.com/calendar/ical/1qikk39qlt3a5qe19slokqiftg%40group.calendar.google.com/public/basic.ics"
UA = "Mozilla/5.0 (compatible; FokkAsfaltJekyll/1.0; +https://fokkasfalt.no)"
SKIP = /konsultasjon|bursdag|\bmøte\b|\blege\b|\btannlege\b/i

def fetch_ics
  uri = URI(ICS_URL)
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) do |http|
    req = Net::HTTP::Get.new(uri)
    req["User-Agent"] = UA
    http.request(req)
  end
  raise "ICS HTTP #{res.code}" unless res.is_a?(Net::HTTPSuccess)
  res.body.to_s.force_encoding("UTF-8")
end

def unfold(ics)
  ics.gsub("\r\n", "\n").gsub("\r", "\n").gsub(/\n[ \t]/, "")
end

def unescape(s)
  s.to_s.gsub("\\n", " ").gsub("\\,", ",").gsub("\\;", ";").gsub("\\\\", "\\")
end

def strip_flag(s)
  s.sub(/\A[\u{1F1E6}-\u{1F1FF}]{2}\s*/, "")
end

def clean_name(raw)
  s = unescape(raw)
  s = strip_flag(s)
  s = s.split("|", 1).first.to_s
  s = s.gsub(/\u00a0/, " ").gsub(/\s+/, " ").strip.gsub(/\A[-–—|]+/, "").strip
  s
end

def norm_name(s)
  s.downcase
    .unicode_normalize(:nfd)
    .gsub(/[\u0300-\u036f]/, "")
    .gsub(/[®™]/, "")
    .gsub(/[^a-z0-9æøå]+/i, " ")
    .gsub(/\s+/, " ")
    .strip
end

def parse_events(ics)
  unfold(ics).split("BEGIN:VEVENT").drop(1).filter_map do |block|
    next if block.match?(/^STATUS:CANCELLED/i)
    start = block[/^DTSTART(?:;VALUE=DATE)?:(\d{8})/]
    summary = block[/^SUMMARY:(.+)/]
    next unless start && summary

    date = Regexp.last_match(1)
    name = clean_name(summary.sub(/\ASUMMARY:/, ""))
    next if name.length < 3
    next if name.match?(SKIP)
    next if name.match?(/\b20\d{2}\b/)
    next if name.casecmp("VM").zero?

    url = unescape(block[/^URL:(.+)/, 1].to_s).strip
    url = "" unless url.match?(%r{\Ahttps?://}i)
    iso = "#{date[0, 4]}-#{date[4, 2]}-#{date[6, 2]}"
    { name: name, date_iso: iso, url: url }
  end
end

def catalog_from(events)
  grouped = {}
  events.each do |ev|
    key = norm_name(ev[:name])
    next if key.empty?
    row = grouped[key] ||= { name: ev[:name], dates: {}, url: "" }
    row[:dates][ev[:date_iso][0, 4]] = ev[:date_iso]
    row[:name] = ev[:name] if ev[:date_iso] >= (row[:dates].values.max || "")
    row[:url] = ev[:url] if !ev[:url].empty? && (row[:url].empty? || ev[:date_iso] >= (row[:dates].values.max || ""))
  end

  grouped.values.filter_map do |row|
    latest = row[:dates].values.max
    next unless latest
    month_day = latest[5, 5]
    {
      "name" => row[:name],
      "month_day" => month_day,
      "url" => row[:url],
      "dates" => row[:dates].sort.to_h
    }
  end.sort_by { |row| [row["month_day"], row["name"].downcase] }
end

events = parse_events(fetch_ics)
catalog = catalog_from(events)
FileUtils.mkdir_p(File.dirname(OUT))
File.write(OUT, JSON.pretty_generate(catalog) + "\n")
warn "Skrev #{catalog.size} løp til #{OUT.delete_prefix(ROOT + '/')} (fra #{events.size} kalenderhendelser)."
