<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

interface PageMeta {
  slug: string
  title: string
  type: string | null
  tags: string[]
  updated: string | null
  created: string | null
  layer: string
  wikiManaged: boolean
  excerpt: string
}
interface PageDetail {
  slug: string
  frontmatter: { title: string; type: string | null; tags: string[]; sources: string[]; updated: string | null }
  content: string
}
interface DirNode {
  path: string
  name: string
  pages: PageMeta[]
  children: DirNode[]
  count: number
}
interface TreeRow {
  kind: 'dir' | 'page'
  name: string
  path: string
  depth: number
  page?: PageMeta
}

const pages = ref<PageMeta[]>([])
const query = ref('')
const onlyWiki = ref(true)
const detail = ref<PageDetail | null>(null)
const error = ref('')
const dark = ref(false)
const viewMode = ref<'timeline' | 'tree'>('timeline')
const collapsed = ref<Set<string>>(new Set()) // tree folders collapsed by user; default fully expanded
const navOpen = ref(false) // mobile drawer state (desktop: nav always visible)
const basenameToSlug = new Map<string, string>()

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return pages.value.filter((p) => {
    if (onlyWiki.value && !p.wikiManaged) return false
    if (!q) return true
    return (p.title + ' ' + p.tags.join(' ') + ' ' + p.excerpt).toLowerCase().includes(q)
  })
})

const tree = computed(() => {
  const rootPages: PageMeta[] = []
  const children: DirNode[] = []
  const counts = new Map<string, number>()
  const byPath = new Map<string, DirNode>()
  for (const p of filtered.value) {
    const parts = p.slug.split('/')
    if (parts.length === 1) {
      rootPages.push(p)
      continue
    }
    let parent = children
    let cur = ''
    for (const d of parts.slice(0, -1)) {
      cur = cur ? `${cur}/${d}` : d
      let node = byPath.get(cur)
      if (!node) {
        node = { path: cur, name: d, pages: [], children: [], count: 0 }
        byPath.set(cur, node)
        parent.push(node)
      }
      parent = node.children
    }
    byPath.get(cur)!.pages.push(p)
  }
  const count = (n: DirNode): number => {
    n.count = n.pages.length + n.children.reduce((s, c) => s + count(c), 0)
    counts.set(n.path, n.count)
    return n.count
  }
  children.forEach(count)
  const sort = (nodes: DirNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const n of nodes) {
      n.pages.sort((a, b) => a.title.localeCompare(b.title))
      sort(n.children)
    }
  }
  sort(children)
  return { rootPages, children, counts }
})

const treeRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = []
  const t = tree.value
  for (const p of t.rootPages) {
    rows.push({ kind: 'page', name: p.title, path: p.slug, depth: 0, page: p })
  }
  const walk = (nodes: DirNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ kind: 'dir', name: n.name, path: n.path, depth })
      if (collapsed.value.has(n.path)) continue
      for (const p of n.pages) {
        rows.push({ kind: 'page', name: p.title, path: p.slug, depth: depth + 1, page: p })
      }
      walk(n.children, depth + 1)
    }
  }
  walk(t.children, 0)
  return rows
})

function toggleDir(path: string) {
  const s = new Set(collapsed.value)
  if (s.has(path)) s.delete(path)
  else s.add(path)
  collapsed.value = s
}

function applyTheme() {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'
}
function toggleTheme() {
  dark.value = !dark.value
  localStorage.setItem('wiki-theme', dark.value ? 'dark' : 'light')
  applyTheme()
}

onMounted(async () => {
  const saved = localStorage.getItem('wiki-theme')
  dark.value = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme()
  window.addEventListener('hashchange', onHashChange)
  try {
    const res = await fetch('/api/pages')
    pages.value = (await res.json()).pages
    for (const p of pages.value) {
      const base = p.slug.split('/').pop()!
      if (!basenameToSlug.has(base)) basenameToSlug.set(base, p.slug)
    }
  } catch (e) {
    error.value = String(e)
  }
  onHashChange() // deep link / restored history entry
})

function currentSlug(): string | null {
  const m = location.hash.match(/^#\/p\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

function open(slug: string) {
  navOpen.value = false // close mobile drawer when a note is picked
  const want = '#/p/' + encodeURIComponent(slug)
  if (location.hash === want) {
    load(slug) // clicking the already-open page: no hash change, load anyway
  } else {
    location.hash = want // hashchange listener loads the page
  }
}

async function load(slug: string) {
  try {
    const res = await fetch('/api/page/' + slug)
    if (!res.ok) return
    detail.value = await res.json()
  } catch (e) {
    error.value = String(e)
  }
}

function onHashChange() {
  const slug = currentSlug()
  if (slug) load(slug)
  else detail.value = null
}

function sourceHref(s: string): string | null {
  const slug = s.replace(/\.md$/, '')
  return pages.value.some((p) => p.slug === slug) ? '#/p/' + encodeURIComponent(slug) : null
}

const rendered = computed(() => {
  if (!detail.value) return ''
  const md = detail.value.content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => `[${alias ?? target}](#/p/${encodeURIComponent(target)})`,
  )
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string)
})

function onLink(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const m = a.hash.match(/^#\/p\/(.+)$/)
  if (!m) return
  const target = decodeURIComponent(m[1])
  const slug = pages.value.some((p) => p.slug === target)
    ? target
    : basenameToSlug.get(target)
  if (!slug) {
    e.preventDefault() // dangling link: no-op
    return
  }
  if (slug !== target) {
    e.preventDefault() // alias resolved to real slug: navigate via hash ourselves
    location.hash = '#/p/' + encodeURIComponent(slug)
  }
  // exact slug: let the browser follow the href -> hashchange -> load
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="dot"></span>
        <h1>LLM Wiki</h1>
        <span class="sub">{{ pages.length }} notes</span>
      </div>
      <div class="controls">
        <button class="nav-toggle" :aria-label="navOpen ? 'Close navigation' : 'Open navigation'" @click="navOpen = !navOpen">☰</button>
        <input v-model="query" class="search" type="search" placeholder="Search title, tags, content…" />
        <label class="toggle">
          <input v-model="onlyWiki" type="checkbox" />
          <span>llm_wiki only</span>
        </label>
        <button
          class="theme-btn"
          :aria-label="dark ? 'Switch to light mode' : 'Switch to dark mode'"
          :title="dark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          {{ dark ? '☀️' : '🌙' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <main class="main">
      <div v-if="navOpen" class="backdrop" @click="navOpen = false"></div>
      <aside class="list" :class="{ open: navOpen }">
        <div class="list-head">
          <div class="viewswitch">
            <button :class="{ on: viewMode === 'timeline' }" @click="viewMode = 'timeline'">Timeline</button>
            <button :class="{ on: viewMode === 'tree' }" @click="viewMode = 'tree'">Tree</button>
          </div>
          <span class="count">{{ filtered.length }} / {{ pages.length }}</span>
        </div>
        <ul v-if="viewMode === 'timeline'">
          <li
            v-for="p in filtered"
            :key="p.slug"
            :class="{ active: detail?.slug === p.slug }"
            @click="open(p.slug)"
          >
            <div class="row1">
              <span class="badge" :class="p.layer">{{ p.layer }}</span>
              <span class="date">{{ (p.updated || '').slice(0, 10) }}</span>
            </div>
            <div class="title">{{ p.title }}</div>
            <div class="excerpt">{{ p.excerpt }}</div>
          </li>
        </ul>
        <div v-else class="tree">
          <div
            v-for="r in treeRows"
            :key="r.kind + r.path"
            class="trow"
            :style="{ paddingLeft: r.depth * 16 + 6 + 'px' }"
          >
            <button v-if="r.kind === 'dir'" class="trow-dir" @click="toggleDir(r.path)">
              <span class="caret">{{ collapsed.has(r.path) ? '▸' : '▾' }}</span>
              <span class="tname">{{ r.name }}</span>
              <span class="tcount">{{ tree.counts.get(r.path) }}</span>
            </button>
            <div
              v-else
              class="trow-page"
              :class="{ active: detail?.slug === r.path }"
              @click="open(r.page!.slug)"
            >
              {{ r.name }}
            </div>
          </div>
        </div>
      </aside>

      <section class="detail" @click="onLink">
        <div v-if="!detail" class="placeholder">Select a note…</div>
        <template v-else>
          <h2>{{ detail.frontmatter.title }}</h2>
          <div class="meta">
            <span v-if="detail.frontmatter.type" class="type">{{ detail.frontmatter.type }}</span>
            <span v-for="t in detail.frontmatter.tags" :key="t" class="tag">{{ t }}</span>
            <span v-if="detail.frontmatter.updated" class="date">updated {{ detail.frontmatter.updated }}</span>
          </div>
          <p v-if="detail.frontmatter.sources.length" class="sources">
            Sources:
            <span v-for="s in detail.frontmatter.sources" :key="s" class="src-wrap">
              <a v-if="sourceHref(s)" class="src" :href="sourceHref(s)">{{ s }}</a>
              <span v-else class="src">{{ s }}</span>
            </span>
          </p>
          <article class="content" v-html="rendered"></article>
        </template>
      </section>
    </main>
  </div>
</template>

<style>
:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --surface: #fafbfc;
  --hover: #f6f8fa;
  --active: #eef3ff;
  --border: #e5e7eb;
  --border-soft: #f0f0f0;
  --muted: #6b7280;
  --faint: #9ca3af;
  --accent: #4f7cff;
  --link: #2563eb;
  --code-bg: #f3f4f6;
  --tag-bg: #f3f4f6;
  --badge-bg: #e5e7eb;
  --badge-fg: #374151;
  --wiki-badge-bg: #dbeafe;
  --wiki-badge-fg: #1d4ed8;
  --raw-badge-bg: #fef3c7;
  --raw-badge-fg: #92400e;
  --error: #b91c1c;
  --blockquote-fg: #4b5563;
  color-scheme: light;
}
[data-theme='dark'] {
  --bg: #0f1115;
  --fg: #e5e7eb;
  --surface: #161a20;
  --hover: #1c2128;
  --active: #1a2338;
  --border: #2a303a;
  --border-soft: #232830;
  --muted: #9aa4b2;
  --faint: #6b7280;
  --accent: #6d94ff;
  --link: #7aa2ff;
  --code-bg: #1c2128;
  --tag-bg: #232830;
  --badge-bg: #2a303a;
  --badge-fg: #c8ced6;
  --wiki-badge-bg: #1e3a5f;
  --wiki-badge-fg: #9cc3ff;
  --raw-badge-bg: #4a3a12;
  --raw-badge-fg: #f5d78e;
  --error: #f87171;
  --blockquote-fg: #a8b1bd;
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
html,
body {
  overflow-x: hidden; /* never wider than the viewport (mobile zoom-out guard) */
}
body {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--fg);
  background: var(--bg);
  transition: background-color 0.2s, color 0.2s;
}
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.brand h1 {
  font-size: 18px;
  margin: 0;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  align-self: center;
}
.sub {
  color: var(--muted);
  font-size: 13px;
}
.controls {
  display: flex;
  align-items: center;
  gap: 14px;
}
.search {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  width: 260px;
  background: var(--bg);
  color: var(--fg);
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.theme-btn {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg);
  font-size: 15px;
  line-height: 1;
  padding: 5px 9px;
  cursor: pointer;
}
.theme-btn:hover {
  background: var(--hover);
}
.nav-toggle {
  display: none; /* mobile-only drawer trigger */
}
.error {
  margin: 8px 20px;
  color: var(--error);
}
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.list {
  width: 340px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.list-head {
  padding: 6px 14px;
  border-bottom: 1px solid var(--border-soft);
  position: sticky;
  top: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  z-index: 1;
}
.viewswitch {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.viewswitch button {
  border: none;
  background: var(--bg);
  color: var(--muted);
  font-size: 12px;
  padding: 3px 10px;
  cursor: pointer;
}
.viewswitch button.on {
  background: var(--accent);
  color: #fff;
}
.count {
  font-size: 12px;
  color: var(--muted);
}
.tree {
  padding-bottom: 8px;
}
.trow {
  display: flex;
  align-items: center;
}
.trow-dir {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
  padding: 5px 0;
  cursor: pointer;
  width: 100%;
  text-align: left;
}
.trow-dir:hover {
  color: var(--link);
}
.caret {
  font-size: 10px;
  color: var(--muted);
  width: 12px;
}
.tname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tcount {
  margin-left: auto;
  padding-right: 10px;
  font-size: 11px;
  color: var(--faint);
  font-weight: 400;
}
.trow-page {
  font-size: 13px;
  padding: 4px 8px 4px 0;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
  border-left: 2px solid transparent;
}
.trow-page:hover {
  background: var(--hover);
}
.trow-page.active {
  background: var(--active);
  border-left-color: var(--accent);
}
.list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
}
.list li:hover {
  background: var(--hover);
}
.list li.active {
  background: var(--active);
  border-left: 3px solid var(--accent);
}
.row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--badge-bg);
  color: var(--badge-fg);
}
.badge.entities,
.badge.concepts,
.badge.comparisons,
.badge.queries {
  background: var(--wiki-badge-bg);
  color: var(--wiki-badge-fg);
}
.badge.raw {
  background: var(--raw-badge-bg);
  color: var(--raw-badge-fg);
}
.title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.excerpt {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.date {
  font-size: 12px;
  color: var(--faint);
}
.detail {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  min-width: 0;
}
.placeholder {
  color: var(--faint);
  font-size: 15px;
  text-align: center;
  margin-top: 20vh;
}
.detail h2 {
  margin: 0 0 10px;
  font-size: 24px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.type,
.tag {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--badge-fg);
}
.sources {
  font-size: 12px;
  color: var(--muted);
  margin: 4px 0 12px;
}
.src {
  background: var(--hover);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 6px;
  margin-right: 4px;
  display: inline-block;
  color: var(--fg);
  text-decoration: none;
}
a.src:hover {
  color: var(--link);
  border-color: var(--link);
  text-decoration: none;
}
.content {
  line-height: 1.65;
  font-size: 15px;
  max-width: 860px;
}
.content h1,
.content h2,
.content h3 {
  margin-top: 1.4em;
  line-height: 1.3;
}
.content h2 {
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.content code {
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 13px;
}
.content pre {
  background: var(--code-bg);
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
}
.content pre code {
  background: none;
  padding: 0;
}
.content table {
  border-collapse: collapse;
  margin: 12px 0;
  display: block;
  max-width: 100%;
  overflow-x: auto; /* wide tables scroll inside instead of widening the page */
}
.content th,
.content td {
  border: 1px solid var(--border);
  padding: 6px 12px;
  font-size: 14px;
}
.content th {
  background: var(--code-bg);
}
.content blockquote {
  margin: 12px 0;
  padding: 4px 16px;
  border-left: 3px solid var(--border);
  color: var(--blockquote-fg);
}
.content a {
  color: var(--link);
  text-decoration: none;
}
.content a:hover {
  text-decoration: underline;
}
@media (max-width: 760px) {
  .topbar {
    gap: 8px;
  }
  .controls {
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
  }
  .search {
    width: 100%;
  }
  .nav-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font-size: 16px;
    line-height: 1;
    padding: 5px 9px;
    cursor: pointer;
  }
  .list {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(84vw, 340px);
    max-height: none;
    border-right: 1px solid var(--border);
    border-bottom: none;
    box-shadow: 4px 0 16px rgba(0, 0, 0, 0.18);
    z-index: 40;
    transform: translateX(-105%);
    transition: transform 0.18s ease;
    background: var(--bg);
  }
  .list.open {
    transform: none;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 30;
  }
  .detail {
    padding: 16px;
  }
}
</style>
