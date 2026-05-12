#!/usr/bin/env ruby
# frozen_string_literal: true

# Fetches Patreon master RSS and writes one Markdown file per item under _episodes/.
# Jekyll builds static HTML from the collection. Run locally or via GitHub Actions.
#
# Sletter ikke filer der front matter har buzzsprout_only: true (Buzzsprout-episoder
# som ikke finnes i Patreon-feeden — se scripts/import_buzzsprout_only_episodes.rb ).
#
# Env: PATREON_RSS_URL (required), EPISODE_LIMIT (optional, integer)
# Laster automatisk `/.env` i prosjektroten hvis den finnes (kun nøkler som ikke allerede er satt).

require "digest"
require "fileutils"
require "open-uri"
require "rss"
require "time"
require "yaml"

ROOT = File.expand_path("..", __dir__)
OUT_DIR = File.join(ROOT, "_episodes")
UA = "Mozilla/5.0 (compatible; FokkAsfaltJekyll/1.0; +https://fokkasfalt.no)"

# Load optional project .env (does not override vars already set in the shell or CI)
def load_env_file(path)
  return unless File.file?(path)

  File.foreach(path, chomp: true) do |line|
    stripped = line.strip
    next if stripped.empty? || stripped.start_with?("#")

    unless stripped.include?("=")
      if stripped.match?(%r{\Ahttps?://}i) && (ENV["PATREON_RSS_URL"].nil? || ENV["PATREON_RSS_URL"].to_s.strip.empty?)
        ENV["PATREON_RSS_URL"] = stripped
      end
      next
    end

    idx = stripped.index("=")
    next unless idx&.positive?

    key = stripped[0...idx].strip
    val = stripped[(idx + 1)..].strip
    val = val[1..-2] if val.length >= 2 && ((val.start_with?('"') && val.end_with?('"')) || (val.start_with?("'") && val.end_with?("'")))

    next if key.empty?

    ENV[key] = val if ENV[key].nil? || ENV[key].to_s.strip.empty?
  end
end

load_env_file(File.join(ROOT, ".env"))

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

def strip_html(html)
  html.to_s.gsub(/<[^>]+>/, " ").gsub(/\s+/, " ").strip
end

def pick_image_from_html(html)
  return "" if html.nil? || html.empty?
  m = html.match(%r{<img[^>]+src=["']([^"']+)["']}i)
  m ? m[1].strip : ""
end

def pick_image(item, description)
  if item.respond_to?(:enclosure) && item.enclosure
    t = item.enclosure.type.to_s
    return item.enclosure.url.to_s if t.start_with?("image/")
  end
  pick_image_from_html(description.to_s)
end

# Patreon (m.fl.) sender episode-bilde i <itunes:image href="…">. Standard RSS::Parser mapper ikke dette til item.
def itunes_image_map_from_xml(xml)
  h = {}
  xml.scan(%r{<item\b[^>]*>(.*?)</item>}m) do
    block = Regexp.last_match(1)
    link = block[%r{<link>\s*([^<]*?)\s*</link>}i, 1]&.strip
    guid = block[%r{<guid[^>]*>([^<]+)</guid>}i, 1]&.strip
    href_m = block.match(%r{<itunes:image[^>]*\shref\s*=\s*["']([^"']+)["']}i)
    href = href_m&.captures&.first&.strip
    next if href.nil? || href.empty?

    h[link] = href if link && !link.empty?
    h[guid] = href if guid && !guid.empty?
  end
  h
end

def find_in_item_map(map, link, guid)
  return nil if map.nil? || map.empty?

  [link, guid].each do |key|
    next if key.nil? || key.to_s.strip.empty?
    val = map[key.to_s.strip]
    return val if val && !val.to_s.empty?
  end
  nil
end

def find_itunes_cover(itunes_map, link, guid)
  find_in_item_map(itunes_map, link, guid).to_s
end

# Raw string from RSS: seconds as integer, or "H:MM:SS" / "MM:SS" (Apple Podcasts / iTunes).
def parse_itunes_duration(raw)
  s = raw.to_s.strip
  return nil if s.empty?

  unless s.include?(":")
    begin
      n = Integer(s, 10)
      return n if n.positive?
    rescue ArgumentError
      return nil
    end
    return nil
  end

  parts = []
  s.split(":").each do |p|
    parts << Integer(p, 10)
  rescue ArgumentError
    return nil
  end

  case parts.size
  when 1 then parts[0]
  when 2 then (parts[0] * 60) + parts[1]
  when 3 then (parts[0] * 3600) + (parts[1] * 60) + parts[2]
  else nil
  end
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

# Per-item <itunes:duration> (RSS <item> and Atom <entry>).
def itunes_duration_map_from_xml(xml)
  h = {}
  add_duration_for_block = lambda do |block, link, guid|
    next if link.to_s.strip.empty? && guid.to_s.strip.empty?

    dur_m = block.match(%r{<itunes:duration[^>]*>([^<]+)</itunes:duration>}i)
    raw = dur_m&.captures&.first&.strip
    next if raw.nil? || raw.empty?

    h[link.strip] = raw if link && !link.to_s.strip.empty?
    h[guid.strip] = raw if guid && !guid.to_s.strip.empty?
  end

  xml.scan(%r{<item\b[^>]*>(.*?)</item>}m) do
    block = Regexp.last_match(1)
    link = block[%r{<link>\s*([^<]*?)\s*</link>}i, 1]&.strip
    guid = block[%r{<guid[^>]*>([^<]+)</guid>}i, 1]&.strip
    add_duration_for_block.call(block, link, guid)
  end

  xml.scan(%r{<entry\b[^>]*>(.*?)</entry>}m) do
    block = Regexp.last_match(1)
    link_m = block.match(%r{<link[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["']([^"']+)["']}i)
    link = link_m ? link_m[1].strip : block[%r{<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*>}i, 1]&.strip
    guid = block[%r{<id>([^<]+)</id>}i, 1]&.strip
    add_duration_for_block.call(block, link, guid)
  end
  h
end

def atom_items(feed, itunes_map, duration_map)
  list =
    if feed.respond_to?(:items) && feed.items && !feed.items.empty?
      feed.items
    elsif feed.respond_to?(:entries) && feed.entries
      feed.entries
    else
      []
    end
  out = []
  list.each do |entry|
    link = entry.link&.href
    link = entry.links&.first&.href if link.nil? || link.to_s.empty?
    title = entry.title&.content.to_s
    date = nil
    date = entry.published&.content if entry.respond_to?(:published) && entry.published
    date = entry.updated&.content if date.nil? && entry.respond_to?(:updated) && entry.updated
    summary = entry.summary&.content.to_s
    content = entry.content&.content.to_s
    desc = [summary, content].join(" ")
    image = pick_image_from_html(desc)
    eid = entry.id&.content&.to_s
    image = find_itunes_cover(itunes_map, link.to_s, eid) if image.to_s.empty?
    dur_raw = find_in_item_map(duration_map, link.to_s, eid)
    excerpt = strip_html(desc)[0, 280]
    out << {
      title: title,
      link: link.to_s,
      date: date,
      guid: link.to_s,
      image: image,
      excerpt: excerpt,
      duration_raw: dur_raw
    }
  end
  out
end

def rss20_items(channel, itunes_map, duration_map)
  out = []
  channel.items.each do |item|
    title = item.title.to_s
    link = item.link.to_s
    guid = item.guid&.content.to_s
    date = item.pubDate
    desc = item.description.to_s
    image = find_itunes_cover(itunes_map, link, guid)
    image = pick_image(item, desc) if image.to_s.empty?
    dur_raw = find_in_item_map(duration_map, link, guid)
    excerpt = strip_html(desc)[0, 280]
    out << {
      title: title,
      link: link,
      date: date,
      guid: guid,
      image: image,
      excerpt: excerpt,
      duration_raw: dur_raw
    }
  end
  out
end

def parse_feed(url)
  xml = URI.open(url, "User-Agent" => UA, &:read)
  itunes_map = itunes_image_map_from_xml(xml)
  duration_map = itunes_duration_map_from_xml(xml)
  rss = RSS::Parser.parse(xml, false)
  case rss
  when RSS::Rss
    rss20_items(rss.channel, itunes_map, duration_map)
  when RSS::Atom::Feed
    atom_items(rss, itunes_map, duration_map)
  else
    warn "Unknown feed class #{rss.class}, trying rss.channel"
    if rss.respond_to?(:channel) && rss.channel
      rss20_items(rss.channel, itunes_map, duration_map)
    else
      []
    end
  end
end

def write_episode_file(path, fm)
  File.write(path, "#{YAML.dump(fm)}---\n")
end

def load_front_matter(path)
  s = File.read(path, encoding: "UTF-8")
  lines = s.lines
  return {} unless lines.first&.strip == "---"

  buf = []
  lines[1..]&.each do |line|
    break if line.strip == "---"

    buf << line
  end
  YAML.safe_load(buf.join) || {}
rescue Psych::SyntaxError => e
  warn "#{path}: could not parse front matter (#{e.message}), treating as replaceable."
  {}
end

# Safe ISO8601 for RSS/Atom date values; never raises.
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

url = ENV["PATREON_RSS_URL"]
if url.nil? || url.strip.empty?
  warn "Missing PATREON_RSS_URL"
  exit 1
end

begin
  items = parse_feed(url)
rescue OpenURI::HTTPError, SocketError, SystemCallError, Errno::ECONNREFUSED, Errno::ETIMEDOUT => e
  warn "Failed to fetch feed: #{e.class}: #{e.message}"
  exit 1
rescue RSS::Error => e
  warn "Failed to parse RSS/Atom: #{e.class}: #{e.message}"
  exit 1
rescue StandardError => e
  warn "Unexpected error while fetching or parsing feed: #{e.class}: #{e.message}"
  exit 1
end

lim = ENV["EPISODE_LIMIT"]
if lim && !lim.strip.empty?
  begin
    n = Integer(lim, 10)
    items = items[0, n] if n.positive?
  rescue ArgumentError
    warn "Invalid EPISODE_LIMIT=#{lim.inspect}"
  end
end

if items.empty?
  warn "Feed returned no items; refusing to clear #{OUT_DIR}"
  exit 1
end

unless items.any? { |it| !it[:title].to_s.strip.empty? }
  warn "Feed has no items with a non-empty title; refusing to clear #{OUT_DIR}"
  exit 1
end

# Alle Patreon-derivede arkivfiler slettes før reskriving. Filer fra Buzzsprout som ikke matcher
# Patreon (`buzzsprout_only: true` i front matter) beholdes — de finnes ikke i Patreon-master-RSS.
FileUtils.mkdir_p(OUT_DIR)
Dir[File.join(OUT_DIR, "*.md")].each do |f|
  fm = load_front_matter(f)
  next if fm["buzzsprout_only"] == true

  FileUtils.rm_f(f)
end

items.each do |it|
  title = it[:title].to_s
  link = it[:link].to_s
  next if title.empty?

  slug = safe_filename("#{slugify(title)}-#{episode_hash(it[:guid], link, title)}")
  path = File.join(OUT_DIR, "#{slug}.md")

  date_iso = date_to_iso8601(it[:date])

  fm = {
    "title" => title,
    "description" => it[:excerpt].to_s,
    "patreon_url" => link,
    "cover" => it[:image].to_s,
    "og_type" => "article"
  }
  fm["date"] = date_iso if date_iso

  sec = parse_itunes_duration(it[:duration_raw])
  if sec
    lbl = format_duration_hms(sec)
    fm["duration"] = lbl if lbl
    iso = iso8601_duration_from_seconds(sec)
    fm["duration_iso8601"] = iso if iso
  end

  write_episode_file(path, fm)
end

puts "Wrote #{items.size} episode file(s) into _episodes/"