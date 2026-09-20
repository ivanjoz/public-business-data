import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],

  // @genix/ui fuera del optimizador de dependencias, por lo mismo que en facturago: el paquete
  // se publica sin compilar, con módulos `.svelte.ts` que el escáner de Vite no resuelve dentro
  // de node_modules y que vite-plugin-svelte intenta parsear como Svelte.
  optimizeDeps: {
    exclude: ['@genix/ui'],
    noDiscovery: true,
    // En dev no hay tree-shaking, así que un import de componente arrastra el grafo entero de
    // la librería. Estas son las que hay que pre-empaquetar para que no se sirvan en crudo.
    include: [
      'dexie',
      'axios',
      'date-fns',
      'dompurify',
      'esm-env',
      'excelize-wasm',
      '@jsquash/avif',
      '@humanspeak/svelte-virtual-list',
      '@ivanjoz/minijson',
    ],
  },

  // Vite externaliza las dependencias SSR en dev y Node se niega a quitar tipos de un .ts
  // dentro de node_modules; @genix/ui y minijson se publican en TypeScript.
  ssr: { noExternal: ['@genix/ui', '@ivanjoz/minijson'] },

  server: {
    // El puerto lo fija start.js, que antes lo libera. strictPort para que un puerto ocupado
    // sea un error y no un salto silencioso al 3574 que deja las URLs impresas mintiendo.
    port: Number(process.env.PBD_PORT ?? 3573),
    strictPort: true,
    // El cliente vive en el mismo repo y se consume como fuente: el sitio es su primer
    // consumidor, así que un cambio en clients/typescript se ve aquí sin publicar nada.
    fs: { allow: ['..'] },
  },

  build: { target: 'es2022' },
})
