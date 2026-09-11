import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig(async () => {
  // Держим состояние Wrangler и Miniflare внутри проекта. Это настройки
  // инструментов, а не секреты: секреты живут в `.env*`, который не в git.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler запоминает путь к журналу в момент импорта плагина Cloudflare.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          main: "./worker/index.ts",
          compatibility_flags: ["nodejs_compat"],
        },
      }),
    ],
  };
});
