import { defineConfig } from "@workerstack/repo"

export default defineConfig({
	packs: ["agents", "docs"],
	link: { push: "allow" },
	workflow: "main",
	agents: {
		defaultApproval: "ask",
		defaultEffort: "fast",
		defaultStrategy: "spawn-fast",
		hosts: ["claude", "codex", "antigravity", "grok", "cursor"],
	},
})
