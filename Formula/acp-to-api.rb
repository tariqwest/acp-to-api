# typed: false
# frozen_string_literal: true

class AcpToApi < Formula
  desc "OpenAI-compatible REST gateway for local ACP (Agent Client Protocol) agents"
  homepage "https://github.com/tariqwest/acp-to-api#readme"
  url "https://github.com/tariqwest/acp-to-api/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  head "https://github.com/tariqwest/acp-to-api.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  service do
    run [opt_bin/"acp-to-api"]
    keep_alive true
    require_root false
    log_path var/"log/acp-to-api.log"
    error_log_path var/"log/acp-to-api.error.log"
    working_dir HOMEBREW_PREFIX
    environment_variables ACP_TO_API_HOST: "*********", ACP_TO_API_PORT: "8787"
  end

  def caveats
    <<~EOS
      acp-to-api is an OpenAI-compatible REST gateway for local ACP agents.

      Start the server:

        #{bin}/acp-to-api

      Or run it as a managed service with Homebrew services:

        brew services start acp-to-api
        brew services stop acp-to-api
        brew services restart acp-to-api

      Defaults to http://*********:8787. Useful env vars:

        ACP_TO_API_HOST
        ACP_TO_API_PORT
        ACP_TO_API_TOKEN
        ACP_TO_API_CWD
        ACP_TO_API_PERMISSION_MODE

      Install one or more ACP agents on PATH (opencode, devin, oz-acp, agy-acp, fm-acp).
      Prefer Bun when available; Node uses the bundled tsx loader.
    EOS
  end

  test do
    assert_path_exists bin/"acp-to-api"
    pkg_json = libexec/"lib/node_modules/acp-to-api/package.json"
    assert_path_exists pkg_json
    assert_match version.to_s, pkg_json.read
  end
end
