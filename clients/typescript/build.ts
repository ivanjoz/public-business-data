/**
 * Builds the single file other projects import. It lands in two places for two ways of
 * consuming it, from one build so they can never disagree:
 *
 *   docs/client.mjs        publicado junto a los datos, importable por URL sin instalar nada
 *   clients/typescript/dist/client.mjs   lo que resuelve el `exports` del paquete npm
 *
 * The .d.ts is emitted by tsc into dist/types and re-exported from a one-line dist/client.d.ts,
 * so a bundler picks up the types next to the bundle.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const clientDir = import.meta.dirname
const distDir = join(clientDir, 'dist')
const docsDir = join(clientDir, '../../docs')

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

const built = await Bun.build({
	entrypoints: [join(clientDir, 'src/index.ts')],
	target: 'browser',
	format: 'esm',
	minify: true,
	// No external and no splitting: the whole point is one file with nothing to resolve.
	naming: 'client.mjs',
	outdir: distDir,
})

if (!built.success) {
	for (const log of built.logs) console.error(log)
	process.exit(1)
}

const bundle = await Bun.file(join(distDir, 'client.mjs')).text()

const banner = `// @ivanjoz/public-business-data — cliente de https://public-business-data.un.pe
// Generado por clients/typescript/build.ts. No editar a mano.
`
const output = banner + bundle
await writeFile(join(distDir, 'client.mjs'), output)
await writeFile(join(docsDir, 'client.mjs'), output)

// Los tipos van al lado del bundle para que un bundler los encuentre por el `types` del
// package.json. tsc no sabe emitir un .d.ts único, así que emite el árbol y esto lo reexporta.
// Con un archivo suelto en la línea de comandos tsc ignora el tsconfig, así que va por
// tsconfig.build.json: el mismo target y lib que el typecheck, sin los tests.
const types = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
	cwd: clientDir,
	stdout: 'pipe',
	stderr: 'pipe',
})

if (types.exitCode !== 0) {
	// tsc escribe los diagnósticos en stdout, no en stderr: sin esto el build fallaba en silencio.
	console.error(types.stdout.toString() + types.stderr.toString())
	process.exit(1)
}
await writeFile(join(distDir, 'client.d.ts'), `export * from './types/index'\n`)

console.log(`client.mjs  ${(output.length / 1024).toFixed(1)} KB`)
console.log(`  → ${join(distDir, 'client.mjs')}  (+ client.d.ts)`)
console.log(`  → ${join(docsDir, 'client.mjs')}`)
