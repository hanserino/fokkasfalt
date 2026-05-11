#!/usr/bin/env ruby
# frozen_string_literal: true

# Generates small WebP thumbnails under assets/episode-thumbs/<slug>.webp from each
# episode's remote `cover` URL, and writes `thumb:` into the episode front matter
# (site-relative path, e.g. /assets/episode-thumbs/foo.webp). Episode pages keep
# using full `cover` for the hero and JSON-LD.
#
# Requires: ImageMagick on PATH + `bundle install` (mini_magick).
#
# Env:
#   THUMB_FORCE — if "1" or "true", re-download and re-encode even when the .webp already exists.
#                 By default, existing files are skipped (fast); missing files are always generated.
#   THUMB_SIZE — max square edge in px (default 160; fits 4.5rem list thumbs at 2x DPR).
#   THUMB_QUALITY — WebP quality 1–100 (default 82).
#   THUMB_HTTP_DELAY_MS — optional pause between HTTP requests (e.g. 40).
#   EPISODE_LIMIT — optional integer; only process first N files (sorted by path).
#
# Loads project .env when present (same pattern as fetch_episodes.rb).

require "fileutils"
require "open-uri"
require "yaml"

ROOT = File.expand_path("..", __dir__)
EPISODES_DIR = File.join(ROOT, "_episodes")
THUMBS_DIR = File.join(ROOT, "assets", "episode-thumbs")
UA = "Mozilla/5.0 (compatible; FokkAsfaltJekyll/1.1; +https://fokkasfalt.no)"

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

require "mini_magick"

begin
  MiniMagick.cli_version
rescue MiniMagick::Error
  warn <<~MSG
    ImageMagick or GraphicsMagick is not installed or not on PATH.
    macOS (Homebrew):  brew install imagemagick
    Ubuntu/CI:        sudo apt-get install -y imagemagick
  MSG
  exit 1
end

def parse_md(path)
  raw = File.read(path)
  return [nil, nil] unless raw.start_with?("---\n")

  rest = raw[4..]
  sep_idx = rest.index(/\n---\n/)
  return [nil, nil] unless sep_idx

  yaml_str = rest[0...sep_idx]
  body = rest[(sep_idx + "\n---\n".length)..] || ""
  fm = YAML.safe_load(
    yaml_str,
    permitted_classes: [Time, Date, DateTime, Symbol],
    permitted_symbols: [],
    aliases: true
  )
  [fm, body]
rescue Psych::Exception, ArgumentError => e
  warn "Skip #{path}: #{e.class}: #{e.message}"
  [nil, nil]
end

def write_md(path, fm, body)
  File.write(path, "#{YAML.dump(fm)}---\n#{body}")
end

def truthy?(s)
  %w[1 true yes y on].include?(s.to_s.strip.downcase)
end

size = Integer(ENV.fetch("THUMB_SIZE", "160"), 10)
quality = Integer(ENV.fetch("THUMB_QUALITY", "82"), 10)
quality = [[quality, 1].max, 100].min
force_regen = truthy?(ENV["THUMB_FORCE"])
delay_ms = ENV["THUMB_HTTP_DELAY_MS"].to_s.strip
sleep_s = delay_ms.empty? ? 0.0 : (Float(delay_ms, exception: false) || 0.0) / 1000.0

limit_env = ENV["EPISODE_LIMIT"].to_s.strip
limit = limit_env.empty? ? nil : Integer(limit_env, 10)

FileUtils.mkdir_p(THUMBS_DIR)

paths = Dir.glob(File.join(EPISODES_DIR, "*.md")).sort
paths = paths[0, limit] if limit && limit.positive?

ok = 0
failed = 0
skipped = 0

paths.each do |path|
  fm, body = parse_md(path)
  unless fm.is_a?(Hash)
    skipped += 1
    next
  end

  slug = File.basename(path, ".md")
  cover = fm["cover"].to_s.strip
  thumb_rel = "/assets/episode-thumbs/#{slug}.webp"
  out_file = File.join(THUMBS_DIR, "#{slug}.webp")

  if cover.empty?
    fm.delete("thumb")
    write_md(path, fm, body)
    skipped += 1
    next
  end

  need_file = force_regen || !File.file?(out_file)

  if need_file
    tempfile = nil
    begin
      tempfile = File.join(Dir.tmpdir, "episode-thumb-#{slug}-#{Process.pid}.src")
      URI.open(cover, "User-Agent" => UA, open_timeout: 30, read_timeout: 90) do |io|
        File.binwrite(tempfile, io.read)
      end

      image = MiniMagick::Image.open(tempfile)
      image.auto_orient
      image.combine_options do |c|
        c.resize "#{size}x#{size}^"
        c.gravity "center"
        c.extent "#{size}x#{size}"
      end
      image.format "webp"
      image.quality quality.to_s
      image.write out_file
      image.destroy!
    rescue StandardError => e
      warn "Thumb failed #{slug}: #{e.class}: #{e.message}"
      failed += 1
      FileUtils.rm_f(out_file)
      fm.delete("thumb")
      write_md(path, fm, body)
      sleep(sleep_s) if sleep_s.positive?
      next
    ensure
      FileUtils.rm_f(tempfile) if tempfile && File.file?(tempfile)
    end
  end

  if File.file?(out_file)
    fm["thumb"] = thumb_rel
    ok += 1
  else
    fm.delete("thumb")
  end

  write_md(path, fm, body)
  sleep(sleep_s) if sleep_s.positive?
end

puts "Episode thumbnails: processed #{paths.size} file(s), ok=#{ok}, failed=#{failed}, skipped/empty=#{skipped}."
puts "Output: #{THUMBS_DIR}"
