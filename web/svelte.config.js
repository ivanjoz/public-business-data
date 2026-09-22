import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  compilerOptions: { runes: true },
  kit: {
    adapter: adapter({ pages: 'build', assets: 'build', precompress: false, strict: true }),
    // El sitio se sirve desde la raíz de public-business-data.un.pe, así que no hay prefijo.
    paths: { base: '' },
    prerender: { handleHttpError: 'fail' },

    // ../docs es la carpeta de assets estáticos: el dev server sirve los .gz y el manifest
    // reales en las mismas rutas que producción, así que la página se desarrolla contra los
    // datos publicados y no contra un mock que podría mentir.
    //
    // El build los copia a build/ junto con la app; scripts/publish.mjs devuelve a docs/ sólo lo
    // que la app genera (_app/ y el index.html de cada página), nunca los datos — esos ya viven
    // allí.
    files: { assets: '../docs' },

    // Igual que en facturago: la librería se trata como fuente, no como dependencia. Su mapa
    // de exports manda a TypeScript a buscar .js que sólo existen como .ts.
    alias: {
      '@genix/ui': './node_modules/@genix/ui',
      '$client': '../clients/typescript/src',
    },
  },
}
