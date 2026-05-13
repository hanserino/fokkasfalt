#!/usr/bin/env ruby
# frozen_string_literal: true

# Leser GitHub Discussions i Giscus-kategorien og skriver _data/giscus_comment_counts.yml
# med pathname → antall kommentarer (kun stier med minst én kommentar).
#
# Forutsetter data-mapping «pathname» i Giscus: diskusjonstittel = side-sti (f.eks. /episoder/slug/).
#
# Miljø: GITHUB_TOKEN (repo + discussions read) eller GH_TOKEN

require "json"
require "net/http"
require "uri"
require "yaml"

ROOT = File.expand_path("..", __dir__)
CONFIG_PATH = File.join(ROOT, "_config.yml")
OUT_PATH = File.join(ROOT, "_data", "giscus_comment_counts.yml")

def load_giscus_config
  cfg = YAML.load_file(CONFIG_PATH)
  g = cfg["giscus"] || {}
  repo = g["repo"].to_s.strip
  category_id = g["category_id"].to_s.strip
  raise "Mangler giscus.repo i _config.yml" if repo.empty?
  raise "Mangler giscus.category_id i _config.yml" if category_id.empty?

  parts = repo.split("/", 2)
  raise "giscus.repo må være owner/navn" unless parts.size == 2

  [parts[0], parts[1], category_id]
end

def graphql(token, query, variables)
  uri = URI("https://api.github.com/graphql")
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  req = Net::HTTP::Post.new(uri.path)
  req["Authorization"] = "Bearer #{token}"
  req["Content-Type"] = "application/json"
  req.body = JSON.generate("query" => query, "variables" => variables)
  res = http.request(req)
  body = JSON.parse(res.body)
  unless res.code == "200"
    warn "HTTP #{res.code}: #{body.inspect}"
    exit 1
  end
  if body["errors"]
    warn body["errors"].map { |e| e["message"] }.join("\n")
    exit 1
  end
  body["data"]
end

def path_from_discussion_title(title)
  t = title.to_s.strip
  return nil if t.empty?

  if t.match?(%r{\Ahttps?://}i)
    u = URI.parse(t)
    t = u.path.to_s
  end
  t = "/#{t}" unless t.start_with?("/")
  t = "#{t}/" unless t.end_with?("/")
  t
end

owner, name, category_id = load_giscus_config
token = ENV["GITHUB_TOKEN"].to_s.strip
token = ENV["GH_TOKEN"].to_s.strip if token.empty?
if token.empty?
  warn "Sett GITHUB_TOKEN (eller GH_TOKEN) for å kalle GitHub GraphQL API."
  exit 1
end

query = <<~GRAPHQL
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussions(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          title
          category { id }
          comments {
            totalCount
          }
        }
      }
    }
  }
GRAPHQL

counts = {}
cursor = nil
page = 0

loop do
  page += 1
  data = graphql(
    token,
    query,
    "owner" => owner,
    "name" => name,
    "cursor" => cursor
  )
  disc = data.dig("repository", "discussions")
  unless disc
    warn "Uventet GraphQL-svar (ingen discussions)."
    exit 1
  end

  disc["nodes"].each do |node|
    next if node.nil?
    next unless node.is_a?(Hash)
    next unless node.dig("category", "id") == category_id

    path = path_from_discussion_title(node["title"])
    next unless path&.start_with?("/episoder/")

    n = node.dig("comments", "totalCount").to_i
    counts[path] = n if n.positive?
  end

  break unless disc.dig("pageInfo", "hasNextPage")

  cursor = disc.dig("pageInfo", "endCursor")
  if cursor.nil? || cursor.empty?
    warn "hasNextPage uten endCursor — avbryter."
    break
  end
  if page > 500
    warn "Sikkerhetsgrense: over 50 000 diskusjoner paginert — avbryter."
    break
  end
end

out = { "counts" => counts.sort_by { |k, _| k }.to_h }

File.write(OUT_PATH, YAML.dump(out))

puts "Skrev #{OUT_PATH} med #{out['counts'].size} episode-stier med kommentarer."
