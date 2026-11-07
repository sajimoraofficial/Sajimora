class Sajimora < Formula
  desc "High-performance native cross-language API contract gatekeeper"
  homepage "https://github.com/Jagadeesh-Budda/Sajimora-v0.10"
  version "0.1.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/Jagadeesh-Budda/Sajimora-v0.10/releases/download/v0.1.0/sajimora-v0.1.0-aarch64-apple-darwin.tar.gz"
    else
      url "https://github.com/Jagadeesh-Budda/Sajimora-v0.10/releases/download/v0.1.0/sajimora-v0.1.0-x86_64-apple-darwin.tar.gz"
    end
  end

  on_linux do
    url "https://github.com/Jagadeesh-Budda/Sajimora-v0.10/releases/download/v0.1.0/sajimora-v0.1.0-x86_64-unknown-linux-gnu.tar.gz"
  end

  def install
    bin.install "sajimora"
    bin.install "sajimora-mcp" if File.exist?("sajimora-mcp")
    bin.install "sajimora-source-pilot" if File.exist?("sajimora-source-pilot")
  end

  test do
    assert_match "sajimora 0.1.0", shell_output("#{bin}/sajimora --version")
  end
end
