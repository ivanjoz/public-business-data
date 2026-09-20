// Todo se genera en build: no hay nada que renderizar bajo demanda.
export const prerender = true

// Sin SSR. La página descarga y descomprime los .gz con DecompressionStream y cachea en
// IndexedDB: nada de eso existe en el prerender, y pedirle los datos al sitio mientras el sitio
// se está construyendo es una dependencia circular. El HTML generado es el armazón y el cliente
// lo rellena.
export const ssr = false
export const csr = true

// Emite carpeta/index.html en vez de carpeta.html. La búsqueda sin extensión es una convención
// del host, no una garantía: GitHub Pages la hace, un servidor estático cualquiera no.
export const trailingSlash = 'always'
