/**
 * Builds the single file other projects import: `docs/client.mjs`, publicado junto a los datos
 * y apuntado por el `main` del package.json del raíz. No hay un segundo artefacto en `dist/`:
 * el paquete que se instala es el repositorio entero, así que el bundle publicado y el que
 * resuelve un `import` son el mismo archivo y no pueden discrepar.
 *
 * Los tipos salen del propio `src/`, que es lo que el package.json del raíz declara en `types`.
 * Por eso el build typechequea antes de escribir nada: un error de tipos en el fuente ya no se
 * queda en casa, viaja al consumidor.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const clientDir = import.meta.dirname
const docsClientPath = join(clientDir, '../../docs/client.mjs')

// tsc escribe los diagnósticos en stdout, no en stderr: sin leer los dos el build fallaba
// en silencio.
const typecheck = Bun.spawnSync(['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.json'], {
	cwd: clientDir,
	stdout: 'pipe',
	stderr: 'pipe',
})

if (typecheck.exitCode !== 0) {
	console.error(typecheck.stdout.toString() + typecheck.stderr.toString())
	process.exit(1)
}

const built = await Bun.build({
	entrypoints: [join(clientDir, 'src/index.ts')],
	target: 'browser',
	format: 'esm',
	minify: true,
	// No external and no splitting: the whole point is one file with nothing to resolve.
	naming: 'client.mjs',
})

if (!built.success) {
	for (const log of built.logs) console.error(log)
	process.exit(1)
}

const banner = `// @ivanjoz/public-business-data — cliente de https://public-business-data.un.pe
// Generado por clients/typescript/build.ts. No editar a mano.
`
const output = banner + (await built.outputs[0]!.text())
await writeFile(docsClientPath, output)

console.log(`client.mjs  ${(output.length / 1024).toFixed(1)} KB`)
console.log(`  → ${docsClientPath}`)
