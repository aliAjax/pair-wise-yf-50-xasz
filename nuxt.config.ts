export default defineNuxtConfig({
  // 纯离线前端：localStorage / navigator 仅在浏览器可用，按客户端 SPA 渲染
  ssr: false,
  devtools: { enabled: false },
  compatibilityDate: "2025-07-15",
  modules: ["@pinia/nuxt", "@vueuse/nuxt", "@nuxtjs/i18n"],
  css: ["~/assets/main.css"],
  i18n: {
    locales: [{ code: "zh", language: "zh-CN", name: "中文", file: "zh.json" }],
    defaultLocale: "zh",
    strategy: "no_prefix",
    langDir: "locales",
    bundle: { optimizeTranslationDirective: false }
  },
  app: {
    head: {
      title: "灾后需求评估与任务分派",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  }
});
