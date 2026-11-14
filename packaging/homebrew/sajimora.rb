class Sajimora < Formula
  desc "High-performance native cross-language API contract gatekeeper"
  homepage "https://sajimora.com"
  version "0.2.0-beta.1"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/sajimoraofficial/Sajimora/releases/download/v0.2.0-beta.1/sajimora-v0.2.0-beta.1-aarch64-apple-darwin.tar.gz"
      sha256 "UPDATE_ON_RELEASE"
    else
      url "https://github.com/sajimoraofficial/Sajimora/releases/download/v0.2.0-beta.1/sajimora-v0.2.0-beta.1-x86_64-apple-darwin.tar.gz"
      sha256 "UPDATE_ON_RELEASE"
    end
  end

  on_linux do
    url "https://github.com/sajimoraofficial/Sajimora/releases/download/v0.2.0-beta.1/sajimora-v0.2.0-beta.1-x86_64-unknown-linux-gnu.tar.gz"
    sha256 "UPDATE_ON_RELEASE"
  end

  def install
    bin.install "sajimora"
    bin.install "sajimora-mcp" if File.exist?("sajimora-mcp")
    bin.install "sajimora-source-pilot" if File.exist?("sajimora-source-pilot")
  end

  test do
    assert_match "sajimora", shell_output("#{bin}/sajimora --version")
  end
end
