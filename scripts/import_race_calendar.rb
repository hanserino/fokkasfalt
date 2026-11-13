#!/usr/bin/env ruby
# frozen_string_literal: true

# Imports the Patreon race-calendar Google Sheet (CSV export) to
# workers/patreon-gate/calendar.json (gitignored). Used by the Cloudflare Worker.
#
# Usage:
#   ruby scripts/import_race_calendar.rb
#   ruby scripts/import_race_calendar.rb /path/to/sheet.csv

require "csv"
require "fileutils"
require "json"
require "net/http"
require "uri"

ROOT = File.expand_path("..", __dir__)
OUT = File.join(ROOT, "workers/patreon-gate/calendar.json")
SHEET_ID = "1iDlTeUJUZVLeo2WGFerp1pXlOkofxlTkqhMIHkNNlQk"
SHEET_CSV = "https://docs.google.com/spreadsheets/d/#{SHEET_ID}/export?format=csv&gid=0"

MONTHS = {
  "januar" => 1, "jan" => 1,
  "februar" => 2, "feb" => 2,
  "mars" => 3, "mar" => 3,
  "april" => 4, "apr" => 4,
  "mai" => 5,
  "juni" => 6, "jun" => 6,
  "juli" => 7, "jul" => 7,
  "august" => 8, "aug" => 8,
  "september" => 9, "sep" => 9, "sept" => 9,
  "oktober" => 10, "okt" => 10,
  "november" => 11, "nov" => 11,
  "desember" => 12, "des" => 12
}.freeze

def blank?(s)
  s.to_s.strip.empty?
end

def clean(s)
  s.to_s.gsub(/\u00a0/, " ").strip.gsub(/\s+/, " ")
end

def http_url?(s)
  s.to_s.match?(%r{\Ahttps?://}i)
end

def first_http(raw)
  clean(raw).split.find { |part| http_url?(part) }
end

def strava_url(raw)
  s = first_http(raw)
  return s if s&.include?("strava.com")
  nil
end

def insta_url(raw)
  s = clean(raw)
  return nil if blank?(s) || s.casecmp("instagram").zero?
  http = first_http(s)
  return http if http&.include?("instagram.com")

  handle = s.sub(/\A@/, "")
  return nil if handle.include?(" ") || handle.include?("/") || handle.length < 2
  "https://www.instagram.com/#{handle}/"
end

def extra_url(raw)
  s = first_http(raw)
  return nil if s.nil?
  return nil if s.include?("strava.com") || s.include?("instagram.com")
  s
end

def parse_date_iso(raw)
  s = clean(raw).downcase.tr(".", " ").gsub(/,/, " ").gsub(/\s+/, " ").strip
  return nil if s.empty?

  if (m = s.match(/\A(\d{1,2})\s+(\d{1,2})\s+(\d{4})\z/))
    return format("%04d-%02d-%02d", m[3].to_i, m[2].to_i, m[1].to_i)
  end
  if (m = s.match(/\A(\d{1,2})\s+(\d{1,2})\s+(\d{2})\z/))
    year = m[3].to_i
    year += 2000 if year < 100
    return format("%04d-%02d-%02d", year, m[2].to_i, m[1].to_i)
  end
  if (m = s.match(/\A(\d{1,2})\s+([a-zæøå]+)\s+(\d{4})\z/))
    month = MONTHS[m[2]]
    return format("%04d-%02d-%02d", m[3].to_i, month, m[1].to_i) if month
  end
  if (m = s.match(/\A(\d{1,2})\s+([a-zæøå]+)\z/))
    month = MONTHS[m[2]]
    return format("%04d-%02d-%02d", 2026, month, m[1].to_i) if month
  end
  nil
end

def load_csv_text(path_or_url)
  if path_or_url && File.file?(path_or_url)
    return File.read(path_or_url, encoding: "UTF-8")
  end

  uri = URI(path_or_url || SHEET_CSV)
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) do |http|
    req = Net::HTTP::Get.new(uri)
    req["User-Agent"] = "FokkAsfaltCalendar/1.0"
    http.request(req)
  end
  raise "Could not download sheet (HTTP #{res.code})" unless res.is_a?(Net::HTTPSuccess)

  res.body.force_encoding("UTF-8")
end

src = ARGV[0] && !ARGV[0].start_with?("-") ? ARGV[0] : SHEET_CSV
csv_text = load_csv_text(src)
rows = CSV.parse(csv_text)
raise "Empty sheet" if rows.nil? || rows.empty?

members = []
current = nil

rows.drop(1).each do |row|
  row = Array.new(9) { |i| row[i] }
  name = clean(row[0])
  race = clean(row[1])
  distance = clean(row[2])
  elevation = clean(row[3])
  date = clean(row[4])
  comment = clean(row[5])
  strava = strava_url(row[6])
  insta = insta_url(row[7])
  race_url = extra_url(row[6]) || extra_url(comment)

  if !blank?(name)
    current = {
      "name" => name,
      "strava" => strava,
      "instagram" => insta,
      "races" => []
    }
    members << current
  elsif current
    current["strava"] ||= strava
    current["instagram"] ||= insta
  end

  next if current.nil? || blank?(race)

  current["races"] << {
    "name" => race,
    "distance" => distance.empty? ? nil : distance,
    "elevation" => elevation.empty? ? nil : elevation,
    "date" => date.empty? ? nil : date,
    "date_iso" => parse_date_iso(date),
    "comment" => comment.empty? ? nil : comment,
    "url" => race_url
  }.compact
end

members.each do |m|
  m.delete("strava") if m["strava"].nil?
  m.delete("instagram") if m["instagram"].nil?
end

payload = {
  "source" => "google-sheet",
  "imported_at" => Time.now.utc.iso8601,
  "members" => members
}

FileUtils.mkdir_p(File.dirname(OUT))
File.write(OUT, JSON.pretty_generate(payload))

race_count = members.sum { |m| m["races"].size }
puts "Wrote #{members.size} members / #{race_count} races → #{OUT}"
