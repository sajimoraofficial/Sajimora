class Sajimora < Formula
  desc "High-performance native cross-language API contract gatekeeper"
  homepage "https://sajimora.com"
  version "0.2.0-beta.1"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/sajimoraofficial/Sajimora/releases/download/v0.2.0-beta.1/sajimora-v0.2.0-beta.1-aarch64-apple-darwin.tar.gz"
      sha256 "d4d292e39a0be4f9e55b9630baee91fbb7db263bf163ba8d7889c91b118f03b4"
    else
      url "https://github.com/sajimoraofficial/Sajimora/releases/download/v0.2.0-beta.1/sajimora-v0.2.0-beta.1-x86_64-apple-darwin.tar.gz"
      sha256 "b1e561a221d433645a03f41de30516183ad206b63611174c750642e3c3b9a173"
    end
  end

  on_linux do
    url "https://github.com/sajimoraofficial/Sajimora/releases/download/v0.2.0-beta.1/sajimora-v0.2.0-beta.1-x86_64-unknown-linux-gnu.tar.gz"
    sha256 "4bd44ebac1b289656647eb9ed27a85cd657f85162e7be02e05ea00fd7a876272"
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
