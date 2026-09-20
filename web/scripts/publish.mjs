/**
 * Lleva el sitio construido a docs/, que es lo que publica GitHub Pages.
 *
 * docs/ ya contiene los datos — los .gz, el manifest, client.mjs, CNAME — escritos por el
 * updater en Go y por el build del cliente. El sitio sólo aporta index.html y _app/, así que
 * esto copia exactamente eso y nada más: un sync con --delete borraría el dataset entero.
 *
 * Antes de copiar, poda los assets huérfanos del build (ver prune()).
 *
 * Con `--clean` no publica: sólo borra de docs/ lo que es del sitio. Eso corre ANTES de vite,
 * porque docs/ es a la vez la salida y la carpeta de assets estáticos del build — sin limpiarla,
 * vite copia el _app de la publicación anterior dentro del nuevo build como si fuera un asset,
 * y cada build arrastra un juego de chunks más que ningún index.html referencia.
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(webDir, 'build')
const docsDir = join(webDir, '..', 'docs')

/** Lo único que el sitio posee dentro de docs/. Todo lo demás es dato y no se toca. */
const ownedByTheSite = ['index.html', '_app']

function walk(directory) {
  const found = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

/**
 * Borra los binarios que el build emite y ningún chunk referencia.
 *
 * Todo componente de genix-ui importa el barrel del runtime, que reexporta createUiRuntime, que
 * alcanza excel/runtime.ts. Ese módulo declara su asset con `new URL(..., import.meta.url)`, y
 * Vite lo emite en el transform, antes de que el tree-shaking decida que el código es
 * inalcanzable. Resultado: el JavaScript se descarta bien y 3,9 MB de excelize se emiten igual,
 * en un sitio que sólo dibuja una tabla.
 *
 * El arreglo de verdad es upstream. Mientras tanto esto barre detrás, y sólo borra un archivo
 * tras confirmar que ningún HTML, JS o CSS del build menciona su nombre.
 */
function prune() {
  const prunable = (path) => /\.(wasm|bin)$/.test(path) || path.includes('/immutable/workers/')
  let removedTotal = 0

  // Repite hasta que nada cambie: borrar un worker deja huérfanos los assets que sólo él citaba.
  for (;;) {
    const files = walk(buildDir)
    const candidates = files.filter(prunable)
    if (candidates.length === 0) break

    const references = files
      .filter((path) => /\.(html|js|css|json)$/.test(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    const orphans = candidates.filter((path) => !references.includes(basename(path)))
    if (orphans.length === 0) break

    for (const orphan of orphans) {
      console.log(`  podado ${orphan.slice(buildDir.length + 1)} (${(statSync(orphan).size / 1e6).toFixed(1)} MB)`)
      unlinkSync(orphan)
      removedTotal++
    }
  }
  return removedTotal
}

/** Borra de docs/ sólo lo que el sitio posee. Los datos viven al lado y no se tocan. */
function cleanDocs() {
  for (const entry of ownedByTheSite) {
    rmSync(join(docsDir, entry), { recursive: true, force: true })
  }
}

if (process.argv.includes('--clean')) {
  console.log('==> Limpiando el sitio anterior de docs/')
  cleanDocs()
  process.exit(0)
}

if (!existsSync(buildDir)) {
  console.error('No existe web/build — corre `bun run build` primero.')
  process.exit(1)
}

console.log('==> Podando assets huérfanos')
const pruned = prune()
if (pruned === 0) console.log('  nada que podar')

console.log('==> Publicando en docs/')
for (const entry of ownedByTheSite) {
  const source = join(buildDir, entry)
  const target = join(docsDir, entry)
  if (!existsSync(source)) {
    console.error(`  falta ${entry} en el build`)
    process.exit(1)
  }
  // Se borra antes de copiar por si el build anterior dejó algo con otro nombre.
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  console.log(`  docs/${entry}`)
}
