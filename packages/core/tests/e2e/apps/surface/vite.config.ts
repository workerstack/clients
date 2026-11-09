import { honeyPlugin } from "@workerstack/backend/plugin"

export default {
	plugins: [
		honeyPlugin({
			app: "src/gen-app.ts",
			codegen: {
				manifest: true,
				openApi: { title: "Honey Surface", version: "1.0.0" },
				tree: true,
				types: true,
			},
		}),
	],
}
