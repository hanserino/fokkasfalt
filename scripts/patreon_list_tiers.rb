#!/usr/bin/env ruby
# frozen_string_literal: true

# Lists Patreon campaign tiers (id, amount, title) so we can gate /race-kalender-2027/.
# Reads .env in the project root. Never prints access/refresh tokens.
#
# Env: PATREON_CREATOR_ACCESS_TOKEN (required unless refresh works),
#      PATREON_CREATOR_REFRESH_TOKEN, PATREON_CLIENT_ID, PATREON_CLIENT_SECRET
#      (refresh is used automatically if the access token is rejected).

require "json"
require "net/http"
require "uri"

ROOT = File.expand_path("..", __dir__)
UA = "Mozilla/5.0 (compatible; FokkAsfaltJekyll/1.0; +https://fokkasfalt.no)"
API = "https://www.patreon.com/api/oauth2/v2"
TOKEN_URL = "https://www.patreon.com/api/oauth2/token"

def load_env_file(path)
  return unless File.file?(path)

  File.foreach(path, chomp: true) do |line|
    stripped = line.strip
    next if stripped.empty? || stripped.start_with?("#")
    next unless stripped.include?("=")

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

def http_json(method, url, headers: {}, form: nil)
  uri = URI(url)
  req = method == :post ? Net::HTTP::Post.new(uri) : Net::HTTP::Get.new(uri)
  headers.each { |k, v| req[k] = v }
  req["User-Agent"] = UA
  req.set_form_data(form) if form
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
  body = res.body.to_s
  parsed = body.empty? ? {} : JSON.parse(body)
  [res.code.to_i, parsed]
rescue JSON::ParserError
  [res.code.to_i, { "raw" => body[0, 400] }]
end

def refresh_access_token
  client_id = ENV["PATREON_CLIENT_ID"].to_s.strip
  client_secret = ENV["PATREON_CLIENT_SECRET"].to_s.strip
  refresh = ENV["PATREON_CREATOR_REFRESH_TOKEN"].to_s.strip
  if client_id.empty? || client_secret.empty? || refresh.empty?
    warn "Access token ble avvist, og refresh mangler CLIENT_ID / CLIENT_SECRET / CREATOR_REFRESH_TOKEN."
    return nil
  end

  code, json = http_json(
    :post,
    TOKEN_URL,
    headers: { "Content-Type" => "application/x-www-form-urlencoded" },
    form: {
      "grant_type" => "refresh_token",
      "refresh_token" => refresh,
      "client_id" => client_id,
      "client_secret" => client_secret
    }
  )
  unless code == 200 && json["access_token"]
    warn "Kunne ikke fornye creator-token (HTTP #{code})."
    return nil
  end

  ENV["PATREON_CREATOR_ACCESS_TOKEN"] = json["access_token"]
  warn "Creator access token ble fornyet. Oppdater PATREON_CREATOR_ACCESS_TOKEN i .env (ny refresh-token også, hvis Patreon sendte en)."
  warn "Ny refresh-token ble returnert — oppdater PATREON_CREATOR_REFRESH_TOKEN i .env." if json["refresh_token"].to_s.strip != ""
  json["access_token"]
end

def authorized_get(path)
  token = ENV["PATREON_CREATOR_ACCESS_TOKEN"].to_s.strip
  if token.empty?
    token = refresh_access_token
  end
  if token.to_s.empty?
    warn "Mangler PATREON_CREATOR_ACCESS_TOKEN i .env"
    exit 1
  end

  url = "#{API}#{path}"
  code, json = http_json(:get, url, headers: { "Authorization" => "Bearer #{token}" })
  if [401, 403].include?(code)
    token = refresh_access_token
    exit 1 if token.to_s.empty?

    code, json = http_json(:get, url, headers: { "Authorization" => "Bearer #{token}" })
  end
  [code, json]
end

query = [
  "include=tiers",
  "fields%5Bcampaign%5D=creation_name,url",
  "fields%5Btier%5D=title,amount_cents,description"
].join("&")

code, json = authorized_get("/campaigns?#{query}")
unless code == 200
  warn "Patreon API HTTP #{code}: #{json["errors"] || json}"
  exit 1
end

campaigns = json["data"]
if campaigns.nil? || campaigns.empty?
  warn "Ingen campaign funnet for denne tokenen."
  exit 1
end

included = Array(json["included"])
tiers_by_id = {}
included.each do |row|
  next unless row["type"] == "tier"

  tiers_by_id[row["id"]] = row
end

campaigns.each do |camp|
  attrs = camp["attributes"] || {}
  puts "Campaign: #{attrs["creation_name"] || "(uten navn)"}  id=#{camp["id"]}"
  puts "URL: #{attrs["url"]}" if attrs["url"].to_s != ""
  rel = camp.dig("relationships", "tiers", "data") || []
  if rel.empty?
    puts "  (ingen tiers i svaret)"
    next
  end
  puts "Tiers (bruk id i PATREON_TIER_IDS på workeren — ta med høyere nivåer hvis de også skal inn):"
  rel.each do |ref|
    tier = tiers_by_id[ref["id"]] || {}
    t_attrs = tier["attributes"] || {}
    cents = t_attrs["amount_cents"]
    amount = cents.is_a?(Numeric) ? format("%.0f kr/mnd", cents / 100.0) : "?"
    title = t_attrs["title"].to_s.strip
    title = "(uten tittel)" if title.empty?
    puts "  id=#{ref["id"]}  #{amount}  #{title}"
  end
end
