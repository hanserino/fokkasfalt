# frozen_string_literal: true

# Shared Buzzsprout RSS parsing + fuzzy matching (Patreon arkiv vs Buzzsprout-feed).
# Brukes av match_episode_availability.rb og import_buzzsprout_only_episodes.rb.

require "open-uri"
require "rss"
require "time"
require "yaml"

module BuzzsproutMatchCore
  UA = "Mozilla/5.0 (compatible; FokkAsfaltJekyll/1.0; +https://fokkasfalt.no)".freeze
  BUZZ_DEFAULT = "https://feeds.buzzsprout.com/145661.rss".freeze
  FREE_MIN = 0.70
  MAYBE_MIN = 0.55

  BUZZSHOW_PREFIX_RX = /\A#+[\s\p{Zs}]*\d+(?:[\s\p{Zs}]*(?:[\p{Pd}]|[·∙:·|])+[\s\p{Zs}]*)+/u
  NORM_MAX = 96

  class << self
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

    def duration_from_iso8601_extended(iso)
      s = iso.to_s.strip
      return nil unless s.start_with?("PT")

      if (m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/))
        h = (m[1] || 0).to_i
        mi = (m[2] || 0).to_i
        sec = (m[3] || 0).to_i
        return h * 3600 + mi * 60 + sec if h.positive? || mi.positive? || sec.positive?
      end

      nil
    end

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
      h
    end

    def buzzsprout_episode_page_url(item_link, enclosure_url)
      u = item_link.to_s.strip
      return u unless u.empty?

      enc = enclosure_url.to_s.strip
      return "" if enc.empty?

      base = enc.sub(/\.(?:mp3|m4a|wav)(?:\?[^\s]*)?\z/i, "")
      return base if base.match?(%r{\Ahttps?://(?:www\.)?buzzsprout\.com/\d+/episodes/\d+}i)

      ""
    end

    def rss20_items(channel, itunes_map, duration_map)
      out = []
      channel.items.each do |item|
        title = item.title.to_s
        enc_url = item.enclosure&.url.to_s
        link = buzzsprout_episode_page_url(item.link, enc_url)
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

    def parse_feed_rss2(url)
      xml = URI.open(url, "User-Agent" => UA, &:read)
      itunes_map = itunes_image_map_from_xml(xml)
      duration_map = itunes_duration_map_from_xml(xml)
      rss = RSS::Parser.parse(xml, false)
      raise RSS::Error, "Expected RSS 2.0" unless rss.is_a?(RSS::Rss)

      rss20_items(rss.channel, itunes_map, duration_map)
    end

    def normalize_title(t)
      s = t.to_s.strip.downcase
      s = s.gsub(BUZZSHOW_PREFIX_RX, "")
      s = s.gsub(/\Aepisode\s*#?\s*\d+\s*[-–|·:]?\s*/i, "")
      s = s.unicode_normalize(:nfc) if s.respond_to?(:unicode_normalize)
      s = s.gsub(/[""''«»"·]/, " ")
      s = s.gsub(/[^\p{L}\p{N}\s-]/u, " ")
      s.gsub(/\s+/, " ").strip
    end

    def episode_num_from_title(t)
      s = t.to_s.strip
      if (m = s.match(/\A#+[\s\p{Zs}]*(\d+)/))
        return m[1].to_i
      end
      if (m = s.match(/(?:^|[\s\[\(])episode\s+(\d+)/i))
        return m[1].to_i
      end
      if (m = s.match(/\b(?:ep|ep\.)\s*(\d+)\b/i))
        return m[1].to_i
      end
      nil
    end

    def levenshtein(a, b)
      a = a.chars
      b = b.chars
      m = a.length
      n = b.length
      d = Array.new(m + 1) { Array.new(n + 1, 0) }
      (0..m).each { |i| d[i][0] = i }
      (0..n).each { |j| d[0][j] = j }
      (1..m).each do |i|
        (1..n).each do |j|
          cost = a[i - 1] == b[j - 1] ? 0 : 1
          d[i][j] = [
            d[i - 1][j] + 1,
            d[i][j - 1] + 1,
            d[i - 1][j - 1] + cost
          ].min
        end
      end
      d[m][n]
    end

    def text_similarity(a, b)
      return 1.0 if a == b
      a = a[0, NORM_MAX]
      b = b[0, NORM_MAX]
      return 0.0 if a.empty? || b.empty?

      mx = [a.length, b.length].max
      1.0 - (levenshtein(a, b).to_f / mx)
    end

    def time_parse_frontmatter(val)
      return nil if val.nil?

      case val
      when Time
        val.utc
      when String
        begin
          Time.parse(val).utc
        rescue ArgumentError
          nil
        end
      else
        nil
      end
    end

    def duration_from_frontmatter(fm)
      d = fm["duration"]
      if d.is_a?(String) && d.include?(":")
        sec = parse_itunes_duration(d)
        return sec if sec
      end
      iso = fm["duration_iso8601"].to_s
      duration_from_iso8601_extended(iso)
    end

    def buzz_item_to_h(it)
      t = it[:title].to_s
      d = it[:date]
      time =
        case d
        when Time then d.utc
        when String then Time.parse(d).utc rescue nil
        else nil
        end
      sec = parse_itunes_duration(it[:duration_raw])
      {
        title: t,
        norm: normalize_title(t),
        ep_num: episode_num_from_title(t),
        pub_utc: time,
        duration_sec: sec,
        guid: it[:guid].to_s,
        link: it[:link].to_s
      }
    end

    def patreon_md_to_h(basename, fm)
      title = fm["title"].to_s
      return nil if title.empty?

      {
        slug: basename,
        title: title,
        norm: normalize_title(title),
        ep_num: episode_num_from_title(title),
        pub_utc: time_parse_frontmatter(fm["date"]),
        duration_sec: duration_from_frontmatter(fm)
      }
    end

    def match_score(pat, buzz)
      n1 = pat[:norm]
      n2 = buzz[:norm]
      sim = text_similarity(n1, n2)

      if pat[:ep_num] && buzz[:ep_num] && pat[:ep_num] != buzz[:ep_num]
        return -1.0
      end

      bonus = 0.0
      bonus += 0.12 if pat[:ep_num] && pat[:ep_num] == buzz[:ep_num]

      if pat[:pub_utc] && buzz[:pub_utc]
        delta = (pat[:pub_utc] - buzz[:pub_utc]).abs
        bonus += 0.08 if delta < 86_400 * 3
        bonus += 0.04 if delta < 86_400 * 14
      end

      if pat[:duration_sec] && buzz[:duration_sec]
        dd = (pat[:duration_sec] - buzz[:duration_sec]).abs
        bonus += 0.05 if dd <= 90
        sim -= 0.15 if dd > 600
      end

      [sim + bonus, 1.0].min
    end

    def load_episodes_from_disk(ep_dir)
      rows = []
      Dir[File.join(ep_dir, "*.md")].each do |path|
        body = File.read(path)
        parts = body.split(/^---\s*$/m)
        next if parts.size < 2

        fm = begin
          YAML.safe_load(parts[1], permitted_classes: [Time], permitted_symbols: [], aliases: true)
        rescue Psych::SyntaxError, Psych::DisallowedClass => e
          warn "Skip #{path}: #{e.message}"
          next
        end
        base = File.basename(path, ".md")
        h = patreon_md_to_h(base, fm)
        rows << h if h
      end
      rows.sort_by { |r| r[:pub_utc] || Time.at(0) }.reverse
    end

    # pool: Hash { Integer index => buzz_item_to_h-hash }; muteres (matched bort).
    # Returnerer Jekyll-/YAML-rader én per Patreon-post (som match-scriptet).
    def greedy_match_patreon_to_buzz!(patreon_eps, pool)
      results = []
      patreon_eps.each do |pat|
        candidates =
          if pat[:ep_num]
            pool.select { |_, bz| bz[:ep_num].nil? || bz[:ep_num] == pat[:ep_num] }
          else
            pool
          end

        best_idx = nil
        best_score = -Float::INFINITY
        candidates.each do |idx, bz|
          sc = match_score(pat, bz)
          next if sc < best_score

          best_score = sc
          best_idx = idx
        end

        if best_score < 0
          best_idx = nil
          best_score = 0.0
        end

        good_enough = best_idx && best_score >= MAYBE_MIN
        bz = good_enough ? pool[best_idx] : nil

        availability =
          if best_score >= FREE_MIN
            "also_free"
          elsif good_enough
            "uncertain"
          else
            "patreon_only"
          end

        pool.delete(best_idx) if good_enough

        bz_link = good_enough && bz && !bz[:link].to_s.strip.empty? ? bz[:link].to_s.strip : nil

        results << {
          "slug" => pat[:slug],
          "title" => pat[:title],
          "episode_url" => "/episoder/#{pat[:slug]}/",
          "date" => pat[:pub_utc]&.strftime("%Y-%m-%d"),
          "availability" => availability,
          "match_score" => (good_enough ? (best_score * 100.0).round(1) : nil),
          "buzzsprout_title" => (bz ? bz[:title] : nil),
          "buzzsprout_pubdate" => (bz&.dig(:pub_utc)&.strftime("%Y-%m-%d")),
          "buzzsprout_url" => bz_link,
          "buzzsprout_guid" => (bz ? bz[:guid].to_s : nil),
          "buzzsprout_duration_hint_sec" => (bz ? bz[:duration_sec] : nil)
        }
      end
      results
    end
  end
end
