import { defineConfig } from "@workerstack/clients/installers";

// GitHub Releases. Assets live at releases/download/<tag>/; each release also uploads:
//
//   version.txt     "v1.2.3", read through the releases/latest/download/ redirect
//   install.sh      served from releases/latest/download/ too
//   install.ps1
export default defineConfig({
  assetPath: ({ tag, version, os, arch }) =>
    `download/${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
  baseUrl: "https://github.com/acme/my-cli/releases",
  checksumsPath: ({ tag, version }) => `download/${tag}/my-cli_${version}_checksums.txt`,
  latestPath: "latest/download/version.txt",
  name: "my-cli",
  scriptUrls: {
    ps1: "https://github.com/acme/my-cli/releases/latest/download/install.ps1",
    sh: "https://github.com/acme/my-cli/releases/latest/download/install.sh",
  },
});
