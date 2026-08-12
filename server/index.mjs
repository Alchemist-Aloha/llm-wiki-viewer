import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import matter from 'gray-matter'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VAULT = process.env.VAULT_PATH || '/data/vault'
const PORT = Number(process.env.PORT || 8080)
const WIKI_DIRS = new Set(['entities', 'concepts', 'comparisons', 'queries', 'raw'])
const META_FILES = new Set(['index.md', 'log.md', 'SCHEMA.md'])
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

const normArr = (v) => {
  if (!v) return []
  const a = Array.isArray(v) ? v : String(v).split(/\s*,\s*/)
  return a.filter(Boolean).map(String)
}

// Some legacy notes have unparseable YAML frontmatter — degrade to no-frontmatter instead of killing the scan
const safeMatter = (text) => {
  try {
    return matter(text)
  } catch {
    return { data: {}, content: text }
  }
}

async function* walk(dir, rel = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) yield* walk(p, r)
    else if (e.name.endsWith('.md')) yield { p, r }
  }
}

let cache = { t: 0, pages: [] }

async function scan() {
  const out = []
  for await (const { p, r } of walk(VAULT)) {
    if (META_FILES.has(r)) continue
    let text
    try {
      text = await fs.readFile(p, 'utf8')
    } catch {
      continue
    }
    const { data, content } = safeMatter(text)
    const top = r.split('/')[0]
    const wikiManaged = WIKI_DIRS.has(top)
    const excerpt = content
      .trim()
      .replace(/^#.*$/gm, '')
      .replace(/[#*`>[\]|]/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 220)
    let mtime = ''
    try {
      mtime = (await fs.stat(p)).mtime.toISOString().slice(0, 10)
    } catch {}
    out.push({
      slug: r.slice(0, -3),
      title: String(data.title || path.basename(r, '.md')),
      type: data.type || null,
      tags: normArr(data.tags),
      updated: data.updated || mtime,
      created: data.created || null,
      layer: wikiManaged ? top : r.includes('/') ? top : 'root',
      wikiManaged,
      excerpt,
    })
  }
  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
  return out
}

const getPages = async () => {
  if (Date.now() - cache.t < 30_000) return cache.pages
  cache = { t: Date.now(), pages: await scan() }
  return cache.pages
}

const app = Fastify({ logger: true })

app.register(fastifyStatic, { root: DIST, wildcard: false }) // serves dist/index.html at '/'

app.get('/api/ping', () => ({ ok: true }))

app.get('/api/pages', async () => ({ pages: await getPages() }))

app.get('/api/page/*', async (req, reply) => {
  const slug = req.params['*']
  if (!/^[\w./-]+$/.test(slug) || slug.includes('..')) {
    return reply.code(400).send({ error: 'bad slug' })
  }
  const file = path.resolve(VAULT, `${slug}.md`)
  if (!file.startsWith(VAULT + path.sep)) {
    return reply.code(400).send({ error: 'bad slug' })
  }
  try {
    const raw = await fs.readFile(file, 'utf8')
    const { data, content } = safeMatter(raw)
    return {
      slug,
      frontmatter: {
        title: String(data.title || path.basename(slug)),
        type: data.type || null,
        tags: normArr(data.tags),
        sources: normArr(data.sources),
        updated: data.updated || null,
      },
      content,
    }
  } catch {
    return reply.code(404).send({ error: 'not found' })
  }
})

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
  return reply.sendFile('index.html')
})

app.listen({ host: '0.0.0.0', port: PORT })
