#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`Projium needs Node.js 24 or newer; this is ${process.versions.node}. Get it at https://nodejs.org`)
  process.exit(1)
}
const { run } = await import('../lib/cli.mjs')
process.exitCode = await run(process.argv.slice(2))
